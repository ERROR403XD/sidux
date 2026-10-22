import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeQuiescenceSnapshot } from '../accountAuthCoordinator.js'
import type { FreeModeState } from '../freeMode.js'
import { writeFreeModeStateFile } from '../freeModeStateFile.js'
import { readAnyJsonBody } from '../httpUtils.js'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from '../backendQueueRuntime.js'
import { createDeliveryId } from '../../delivery.js'
import { createFreeModeRoutes } from './freeModeRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }

let capturedResponse: TestResponse | null = null
let codexHome: string

async function invoke(
  handler: ReturnType<typeof createFreeModeRoutes>,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<boolean> {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => {
      capturedResponse = { statusCode: response.statusCode, body: String(chunk ?? ''), headers }
    },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(
    request as never as IncomingMessage,
    response,
    new URL(pathname, 'http://localhost'),
    { readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage) },
  )
}

function expectResponse(statusCode: number, payload: unknown) {
  expect(capturedResponse).toEqual({
    statusCode,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function fixture(options: { quiescence?: Partial<RuntimeQuiescenceSnapshot>; state?: FreeModeState; processor?: BackendQueueProcessor } = {}) {
  const idle = { idle: true, activeTurnThreadIds: [], queuedThreadIds: [], pendingServerRequestCount: 0, pendingTurnMutationCount: 0, ...options.quiescence }
  const appServer = {
    dispose: vi.fn(),
    getRuntimeQuiescenceSnapshot: vi.fn(async () => idle as RuntimeQuiescenceSnapshot),
  }
  let changing = false
  const releaseProviderChange = vi.fn(() => { changing = false })
  const providerChangeStarted = vi.fn()
  const backendQueueProcessor = { runProviderChange: async <T>(change: () => Promise<T>): Promise<T> => {
    providerChangeStarted()
    if (changing) throw new Error('Provider is already changing')
    changing = true
    try {
      return await change()
    } finally {
      releaseProviderChange()
    }
  } }
  const handler = createFreeModeRoutes({
    appServer,
    backendQueueProcessor: options.processor ?? backendQueueProcessor,
    getRandomFreeKey: () => options.state?.apiKey ?? 'random-key',
    getFreeKeyCount: () => 4,
    getFreeModels: async () => ['openrouter/free'],
    getCachedFreeModels: () => ['openrouter/free'],
    refreshFreeModelsInBackground: vi.fn(),
    fetchOpenCodeZenModelIds: async () => ['big-pickle', 'paid-model'],
    sortOpenCodeZenModelIds: ids => ids,
    filterOpenCodeZenModelsForAuthState: ids => ids.filter(id => id === 'big-pickle' || id.endsWith('-free')),
    fetchCustomEndpointDefaultModel: async () => 'custom-default',
    shouldMarkOpenRouterKeyAsCustom: (current, apiKey) => Boolean(apiKey || current.customKey),
  })
  return { appServer, backendQueueProcessor, handler, releaseProviderChange, providerChangeStarted }
}

beforeEach(async () => {
  codexHome = (await mkdir(join(tmpdir(), `codex-home-free-routes-${process.pid}-${Date.now()}`), { recursive: true })) as string
  process.env.CODEX_HOME = codexHome
})

afterEach(async () => {
  delete process.env.CODEX_HOME
  await rm(codexHome, { recursive: true, force: true })
})

describe('free mode routes', () => {
  it('allows a second provider change and a new delivery with the real queue admission owner', async () => {
    const { runtime } = createBackendQueueRuntimeFixture()
    const processor = new BackendQueueProcessor(runtime, { startRecovery: false, context: async () => 'fixture-account' })
    const { handler } = fixture({ processor })
    try {
      await invoke(handler, 'POST', '/codex-api/free-mode', { enable: false })
      expectResponse(200, { ok: true, enabled: false })
      await invoke(handler, 'POST', '/codex-api/free-mode', { enable: false })
      expectResponse(200, { ok: true, enabled: false })
      expect(processor.isIdentityChanging()).toBe(false)
      const result = await processor.submit({
        protocol: 2, threadId: 'thread', expectedContextId: 'fixture-account',
        message: { id: createDeliveryId(), text: 'After provider change', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' },
        params: { threadId: 'thread', input: [] },
      })
      expect(result.status).toBe('accepted')
    } finally {
      await processor.dispose()
    }
  })

  it('blocks provider changes while background terminals are active', async () => {
    const { providerChangeStarted, appServer, handler, releaseProviderChange } = fixture({
      quiescence: { idle: false, backgroundThreadIds: ['thread-1'] },
    })
    expect(await invoke(handler, 'POST', '/codex-api/free-mode', { enable: true })).toBe(true)
    expectResponse(409, { error: '请先处理 Codex 后台终端，再切换供应方或密钥。' })
    expect(providerChangeStarted).toHaveBeenCalledTimes(1)
    expect(appServer.dispose).not.toHaveBeenCalled()
    expect(releaseProviderChange).toHaveBeenCalledTimes(1)
    await invoke(handler, 'POST', '/codex-api/free-mode', { enable: true })
    expectResponse(409, { error: '请先处理 Codex 后台终端，再切换供应方或密钥。' })
  })

  it('releases provider admission when the quiescence read throws', async () => {
    const { appServer, handler, releaseProviderChange } = fixture()
    appServer.getRuntimeQuiescenceSnapshot.mockRejectedValueOnce(new Error('Runtime unavailable'))
    await expect(invoke(handler, 'POST', '/codex-api/free-mode', { enable: false })).rejects.toThrow('Runtime unavailable')
    expect(releaseProviderChange).toHaveBeenCalledTimes(1)
    await invoke(handler, 'POST', '/codex-api/free-mode', { enable: false })
    expectResponse(200, { ok: true, enabled: false })
    expect(releaseProviderChange).toHaveBeenCalledTimes(2)
  })

  it('disables free mode and preserves provider keys and wire mode', async () => {
    const statePath = join(codexHome, 'webui-custom-providers.json')
    await writeFreeModeStateFile(statePath, {
      enabled: false,
      apiKey: 'zen-key',
      model: 'big-pickle',
      provider: 'opencode-zen',
      customKey: true,
      wireApi: 'chat',
      providerKeys: { custom: 'custom-key' },
    })
    const { handler, appServer } = fixture({ state: { enabled: true, apiKey: 'zen-key', model: 'big-pickle' } })
    await invoke(handler, 'POST', '/codex-api/free-mode', { enable: false })
    expectResponse(200, { ok: true, enabled: false })
    expect(appServer.dispose).toHaveBeenCalledTimes(1)
    await expect(readFile(statePath, 'utf8')).resolves.toEqual(JSON.stringify({
      enabled: false,
      apiKey: null,
      model: 'openrouter/free',
      wireApi: 'chat',
      providerKeys: { custom: 'custom-key', 'opencode-zen': 'zen-key' },
    }))
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('sets a custom OpenRouter key and rotates back to a community key', async () => {
    const statePath = join(codexHome, 'webui-custom-providers.json')
    await writeFreeModeStateFile(statePath, { enabled: false, apiKey: null, model: 'openrouter/free' })
    const { handler, appServer } = fixture({ state: { enabled: false, apiKey: null, model: 'openrouter/free' } })
    await invoke(handler, 'POST', '/codex-api/free-mode/custom-key', { key: ' custom-key ' })
    expectResponse(200, { ok: true, customKey: true })
    await invoke(handler, 'POST', '/codex-api/free-mode/rotate-key')
    expectResponse(200, { ok: true })
    expect(appServer.dispose).toHaveBeenCalledTimes(2)
    await expect(readFile(statePath, 'utf8')).resolves.toEqual(JSON.stringify({
      enabled: false,
      apiKey: 'random-key',
      model: 'openrouter/free',
      customKey: false,
      provider: 'openrouter',
      wireApi: 'responses',
    }))
  })

  it('requires a custom baseUrl and resolves provider state', async () => {
    const statePath = join(codexHome, 'webui-custom-providers.json')
    await writeFreeModeStateFile(statePath, {
      enabled: false,
      apiKey: 'old-key',
      model: 'old-model',
      provider: 'custom',
      customBaseUrl: 'https://old.example/v1',
      customKey: true,
    })
    const { handler } = fixture()
    await invoke(handler, 'POST', '/codex-api/free-mode/custom-provider', { provider: 'custom' })
    expectResponse(400, { error: 'baseUrl is required' })
    await invoke(handler, 'POST', '/codex-api/free-mode/custom-provider', { provider: 'custom', baseUrl: 'https://api.example/v1', wireApi: 'chat' })
    expectResponse(200, { ok: true })
    await expect(readFile(statePath, 'utf8')).resolves.toEqual(JSON.stringify({
      enabled: true,
      apiKey: 'old-key',
      model: 'custom-default',
      customKey: true,
      provider: 'custom',
      customBaseUrl: 'https://api.example/v1',
      wireApi: 'chat',
      providerKeys: { custom: 'old-key' },
    }))
  })

  it('reports cached OpenRouter and fetched OpenCode Zen status without exposing unmasked keys', async () => {
    await writeFreeModeStateFile(join(codexHome, 'webui-custom-providers.json'), {
      enabled: true,
      apiKey: 'short',
      model: 'openrouter/free',
      provider: 'openrouter',
    })
    const { handler } = fixture()
    await invoke(handler, 'GET', '/codex-api/free-mode/status')
    expectResponse(200, {
      enabled: true,
      hasCodexAuth: false,
      keyCount: 4,
      models: ['openrouter/free'],
      currentModel: 'openrouter/free',
      customKey: false,
      maskedKey: null,
      provider: 'openrouter',
      customBaseUrl: null,
      wireApi: null,
    })
    await writeFreeModeStateFile(join(codexHome, 'webui-custom-providers.json'), {
      enabled: true,
      apiKey: 'short',
      model: 'big-pickle',
      provider: 'opencode-zen',
      wireApi: 'chat',
    })
    await invoke(handler, 'GET', '/codex-api/free-mode/status')
    expect(JSON.parse(capturedResponse?.body ?? '{}')).toMatchObject({ models: ['big-pickle'], wireApi: 'responses' })
    expect(capturedResponse?.body).not.toContain('short')
  })
})
