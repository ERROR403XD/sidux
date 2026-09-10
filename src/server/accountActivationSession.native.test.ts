import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AccountActivationSession } from './accountActivationSession'

// Opt in with CODEXAPP_NATIVE_ACTIVATION_TEST=1; all inference uses this local fixture.
it.skipIf(process.env.CODEXAPP_NATIVE_ACTIVATION_TEST !== '1')('keeps native activation context small and excludes parent project instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'activation-context-native-'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  const token = `fixture.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'activation-B', chatgpt_plan_type: 'plus', user_id: 'activation-B' },
    'https://api.openai.com/profile': { email: 'activation-B@example.test' },
  })).toString('base64url')}.fixture`
  const requests: { account: unknown; correctToken: boolean; input: Array<{ role: string; type: string; content?: Array<{ text?: string }> }> }[] = []
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith('/responses')) {
      response.writeHead(404).end('{}')
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ account: request.headers['chatgpt-account-id'], correctToken: request.headers.authorization === `Bearer ${token}`, input: body.input })
    const message = { id: 'msg-fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!', annotations: [] }] }
    const completed = { id: 'resp-fixture', object: 'response', status: 'completed', output: [message], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Hi!' },
      { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: 'Hi!' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: completed },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not start')
  const baseUrl = `http://127.0.0.1:${address.port}`
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'AGENTS.md'), 'ACTIVATION_PARENT_CONTEXT_SENTINEL: '.repeat(1000))
  await writeFile(join(root, 'auth.json'), 'primary-auth-sentinel')
  await writeFile(join(root, 'accounts.json'), 'primary-selection-sentinel')
  let launchedHome = ''
  let emptyCwd = false
  let runtimeOutput = ''
  const session = new AccountActivationSession(join(root, 'sessions'), { accessToken: token, accountId: 'activation-B' }, {
    model: 'gpt-5.6-luna', signal: controller.signal, cleanupDelayMs: 25, pollMs: 25,
    spawnImpl: ((command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
      launchedHome = options.env!.CODEX_HOME!
      emptyCwd = options.cwd === join(launchedHome, 'empty')
      // Native OpenAI's base URL is immutable; alias only the provider transport to localhost.
      const child = spawn(command, [...args, '-c', 'model_provider="fixture-openai"',
        '-c', 'model_providers.fixture-openai.name="Fixture OpenAI"',
        '-c', `model_providers.fixture-openai.base_url="${baseUrl}"`,
        '-c', 'model_providers.fixture-openai.wire_api="responses"',
        '-c', 'model_providers.fixture-openai.requires_openai_auth=true'], {
        ...options, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...options.env, OPENAI_BASE_URL: baseUrl, CODEX_APP_SERVER_CHATGPT_BASE_URL: baseUrl },
      })
      const write = child.stdin.write.bind(child.stdin)
      child.stdout.on('data', chunk => { runtimeOutput += chunk })
      child.stdin.write = ((line: string, ...rest: any[]) => {
        const message = JSON.parse(line)
        if (message.params?.modelProvider === 'openai') message.params.modelProvider = 'fixture-openai'
        return write(`${JSON.stringify(message)}\n`, ...rest)
      }) as typeof child.stdin.write
      return child
    }) as typeof spawn,
  })
  try {
    await session.prepare()
    expect(emptyCwd).toBe(true)
    expect(await readdir(join(launchedHome, 'empty'))).toEqual([])
    try {
      await session.send(controller.signal)
    } catch (error) {
      const errors = runtimeOutput.split('\n').filter(Boolean).flatMap(line => {
        const message = JSON.parse(line)
        const thread = message.result?.thread
        return thread ? [{ status: thread.status, turns: thread.turns }]
          : message.params?.turn?.error ? [message.params.turn.error] : []
      })
      throw new Error(`${error instanceof Error ? error.message : error}: ${JSON.stringify(errors)}`)
    }
    await session.dispose()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ account: 'activation-B', correctToken: true })
    const input = requests[0]!.input
    expect(input.filter(item => item.role === 'user').flatMap(item => item.content?.map(part => part.text) || [])).toEqual(['hi'])
    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain('ACTIVATION_PARENT_CONTEXT_SENTINEL')
    expect(serialized).not.toContain('<environment_context>')
    expect(serialized).not.toContain('### Skill roots')
    expect(serialized.length).toBeLessThan(9000)
    expect(await readdir(join(root, 'sessions'))).toEqual([])
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('primary-auth-sentinel')
    expect(await readFile(join(root, 'accounts.json'), 'utf8')).toBe('primary-selection-sentinel')
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await session.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 70000)
