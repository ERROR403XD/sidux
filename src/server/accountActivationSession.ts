import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveCodexCommand } from '../commandResolution.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import { AccountProbeRpcClient } from './accountAppServerProbe.js'

/** Private home, empty working directory and fixed external tokens; no login file changes. */
export class AccountActivationSession {
  private home = ''
  private process: ChildProcessWithoutNullStreams | null = null
  private client: AccountProbeRpcClient | null = null
  private abortListener: (() => void) | undefined
  private disposal: Promise<void> | null = null
  constructor(private directory: string, private credential: { accessToken: string; accountId: string }, private options: {
    model: string
    signal: AbortSignal
    spawnImpl?: typeof spawn
    cleanupDelayMs?: number
    pollMs?: number
    command?: string
  }) {}

  async prepare(): Promise<void> {
    this.options.signal.throwIfAborted()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.home = await mkdtemp(join(this.directory, 'session-'))
    const cwd = join(this.home, 'empty')
    await mkdir(cwd)
    const command = this.options.command || resolveCodexCommand()
    if (!command) throw new Error('激活运行时不可用')
    // An empty cwd can still inherit ancestor AGENTS.md and CLI tool/skill catalogs.
    // These overrides belong only to this disposable process, never the main runtime.
    const config = [
      'model_provider="openai"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      'project_doc_max_bytes=0',
      'include_environment_context=false',
      'skills.max_context_tokens=1',
      'web_search="disabled"',
      'features.skip_host_skill_discovery=true',
      'features.memories=false',
      'features.apps=false',
      'features.plugins=false',
      'features.shell_tool=false',
      'features.view_image=false',
      'features.multi_agent=false',
      'features.sleep_tool=false',
      'features.goals=false',
      'features.image_generation=false',
      'features.browser_use=false',
      'features.computer_use=false',
      'features.code_mode_host=false',
    ]
    const invocation = getSpawnInvocation(command, ['app-server', ...config.flatMap(value => ['-c', value])])
    const activationEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.home }
    delete activationEnv.OPENAI_API_KEY
    delete activationEnv.CODEX_API_KEY
    const proc = (this.options.spawnImpl || spawn)(invocation.command, invocation.args, {
      cwd, env: activationEnv, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = proc
    const client = new AccountProbeRpcClient(message => proc.stdin.write(`${JSON.stringify(message)}\n`), async () => { throw new Error('激活凭据已过期') })
    this.client = client
    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        client.handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    proc.stderr.resume()
    proc.on('error', () => client.rejectAll(new Error('激活运行时不可用')))
    proc.on('exit', () => client.rejectAll(new Error('激活运行时已退出')))
    this.abortListener = () => {
      client.rejectAll(new Error('激活已中止'))
      proc.kill('SIGTERM')
    }
    this.options.signal.addEventListener('abort', this.abortListener, { once: true })
    this.options.signal.throwIfAborted()
    await client.call('initialize', { clientInfo: { name: 'codexapp-activation', version: '0.2.17' }, capabilities: { experimentalApi: true } })
    client.notify('initialized')
    await client.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: this.credential.accessToken, chatgptAccountId: this.credential.accountId })
    const result = await client.call('account/read', { refreshToken: false }) as { account?: { id?: string; accountId?: string } }
    const actual = result.account?.id || result.account?.accountId
    if (actual && actual !== this.credential.accountId) throw new Error('激活账号身份不匹配')
  }

  async send(signal: AbortSignal): Promise<void> {
    const client = this.client
    if (!client) throw new Error('激活运行时不可用')
    signal.throwIfAborted()
    const started = await client.call('thread/start', {
      model: this.options.model, modelProvider: 'openai', cwd: join(this.home, 'empty'),
      approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: 'Reply briefly to the greeting. Do not use tools.', developerInstructions: '',
    }) as { thread?: { id?: string } }
    const threadId = started.thread?.id
    if (!threadId) throw new Error('激活会话未创建')
    const startedTurn = await client.call('turn/start', {
      threadId, input: [{ type: 'text', text: 'hi', text_elements: [] }],
      model: this.options.model, effort: 'low', serviceTier: 'default',
    }) as { turn?: { id?: string } }
    const turnId = startedTurn.turn?.id
    if (!turnId) throw new Error('激活回合未确认')
    while (true) {
      signal.throwIfAborted()
      const result = await client.call('thread/read', { threadId, includeTurns: true }) as { thread?: { turns?: Array<{ id: string; status: string; completedAt?: number | null; error?: unknown }> } }
      const turn = result.thread?.turns?.find(row => row.id === turnId)
      if (turn?.status === 'completed') break
      // Before the live turn attaches, Codex can reconstruct an unfinished rollout
      // as interrupted with no completion timestamp or error. Keep waiting for it.
      if (turn && ['failed', 'interrupted'].includes(turn.status) && (turn.completedAt != null || turn.error != null)) throw new Error('激活回合未完成')
      await delay(this.options.pollMs ?? 2000, undefined, { signal })
    }
    await delay(this.options.cleanupDelayMs ?? 120000, undefined, { signal })
  }

  dispose(): Promise<void> {
    if (!this.disposal) this.disposal = this.cleanup()
    return this.disposal
  }
  private async cleanup(): Promise<void> {
    if (this.abortListener) this.options.signal.removeEventListener('abort', this.abortListener)
    const proc = this.process
    this.process = null
    this.client?.rejectAll(new Error('激活会话已清理'))
    this.client = null
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit').catch(() => {})
      proc.stdin.end()
      proc.kill('SIGTERM')
      await Promise.race([exited, delay(1000)])
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
        await Promise.race([exited, delay(1000)])
      }
      if (proc.exitCode === null && proc.signalCode === null) throw new Error('激活会话进程未退出')
    }
    if (this.home) await rm(this.home, { recursive: true, force: true })
  }
}
