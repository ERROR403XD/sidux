import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { privateJson } from './apiProxy/store.js'
import { normalizeModelCapability } from '../modelCapabilities.js'
import { type CustomEndpoint, type CustomConnection, type CustomConnectionDraft, type CustomConnectionSnapshot, applyProbedEfforts, customReasoningEffortLevels, normalizeReasoningEfforts } from '../customConnections.js'

type StoredConnection = Omit<CustomConnection, 'hasApiKey'> & { apiKey: string; runtimeToken: string }
type State = { explicitSelection?: boolean; version: 1; activeId: string | null; connections: StoredConnection[] }
export class CustomConnectionStore {
  readonly ready: Promise<void>
  private state: State = { version: 1, activeId: null, connections: [] }
  private writes: Promise<unknown> = Promise.resolve()
  private proofs = new Map<string, { digest: string; models: CustomConnection['models']; supportedEndpoints: CustomEndpoint[]; wireApi: 'responses' | 'chat'; reasoningEfforts: string[]; testedAt: string; expires: number }>()
  constructor(readonly home: string, private fetcher: typeof fetch = (...args) => fetch(...args)) { this.ready = this.restore() }
  private async restore(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(join(this.home, 'custom-connections.json'), 'utf8')) as State
      if (value.version !== 1 || !Array.isArray(value.connections) || value.connections.some(row => !/^[a-f0-9]{64}$/.test(row.storageId) || typeof row.apiKey !== 'string' || !Array.isArray(row.models))) throw new Error('自定义连接配置损坏')
      // Connections saved before the protocol bridge toggle existed default to off.
      value.connections = value.connections.map(row => ({ ...row, protocolBridge: row.protocolBridge === true, reasoningEfforts: normalizeReasoningEfforts(row.reasoningEfforts) }))
      this.state = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.importLegacy()
    }
  }
  private async importLegacy(): Promise<void> {
    let legacy: any
    try { legacy = JSON.parse(await readFile(join(this.home, 'webui-custom-providers.json'), 'utf8')) }
    catch { return }
    if (!legacy?.apiKey?.trim() || (legacy.provider === 'openrouter' && !legacy.customKey)) return
    const baseUrl = legacy.provider === 'custom' ? legacy.customBaseUrl : legacy.provider === 'opencode-zen' ? 'https://opencode.ai/zen/v1' : 'https://openrouter.ai/api/v1'
    if (!baseUrl || !legacy.model) return
    const row: StoredConnection = {
      storageId: randomBytes(32).toString('hex'), alias: legacy.provider === 'custom' ? 'Custom API' : legacy.provider === 'opencode-zen' ? 'OpenCode' : 'OpenRouter',
      provider: legacy.provider === 'opencode-zen' ? 'opencode' : legacy.provider || 'custom', baseUrl, apiKey: legacy.apiKey, model: legacy.model,
      wireApi: legacy.wireApi === 'chat' ? 'chat' : 'responses', protocolBridge: false, revision: 1, runtimeToken: randomBytes(24).toString('hex'),
      models: [{ ...normalizeModelCapability(legacy.model, 'custom')!, efforts: [], serviceTiers: [] }],
    }
    const state: State = { version: 1, activeId: legacy.enabled ? row.storageId : null, explicitSelection: !!legacy.enabled, connections: [row] }
    await privateJson(join(this.home, 'custom-connections.json'), state)
    this.state = state
  }
  // Stored models stay as probed; the probe-confirmed reasoning efforts are
  // merged in on read so the composer picker matches what the wire accepts.
  private materialize(row: StoredConnection): StoredConnection {
    return { ...row, models: applyProbedEfforts(row.models, normalizeReasoningEfforts(row.reasoningEfforts)) }
  }
  get(id: string | null | undefined): StoredConnection | undefined {
    const row = this.state.connections.find(item => item.storageId === id)
    return row ? this.materialize(row) : undefined
  }
  explicitSelection(): boolean { return this.state.explicitSelection === true }
  active(): StoredConnection | undefined { return this.get(this.state.activeId) }
  snapshot(): CustomConnectionSnapshot {
    return {
      activeId: this.state.activeId,
      connections: this.state.connections.map(row => {
        const { apiKey, runtimeToken: _token, ...rest } = this.materialize(row)
        return { ...structuredClone(rest), hasApiKey: !!apiKey }
      }),
    }
  }
  private mutate(update: () => State): Promise<void> {
    const write = this.writes.then(async () => {
      await this.ready
      const state = update()
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      await privateJson(join(this.home, 'custom-connections.json'), state)
      this.state = state
    })
    this.writes = write.catch(() => {})
    return write
  }
  private draft(input: CustomConnectionDraft): CustomConnectionDraft {
    if (!input || typeof input !== 'object') throw new Error('连接配置无效')
    const previous = input.storageId ? this.get(input.storageId) : undefined
    if (input.storageId && !previous) throw new Error('自定义连接已移除')
    const alias = typeof input.alias === 'string' ? input.alias.trim() : ''
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : previous?.apiKey || ''
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    let url: URL
    try { url = new URL(input.baseUrl) } catch { throw new Error('请输入有效的 Base URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 Base URL')
    if (!alias || alias.length > 80 || !apiKey || apiKey.length > 8192 || /[\r\n]/.test(apiKey) || model.length > 200) throw new Error('请填写别名、API key 和有效模型')
    return { storageId: input.storageId, alias, provider: String(input.provider || 'custom').slice(0, 50), baseUrl: url.href.replace(/\/+$/, ''), model, apiKey, wireApi: input.wireApi === 'chat' ? 'chat' : 'responses', protocolBridge: input.protocolBridge === true }
  }
  // wireApi comes from the endpoint probe and protocolBridge is a local
  // toggle — neither changes what a test proves, so both stay out of the
  // digest. Reasoning efforts are probe-derived and never part of the draft.
  private digest(input: CustomConnectionDraft): string { return createHash('sha256').update(JSON.stringify({ ...input, wireApi: undefined, protocolBridge: undefined })).digest('hex') }
  async test(input: CustomConnectionDraft): Promise<{ token: string; models: CustomConnection['models']; model: string; supportedEndpoints: CustomEndpoint[]; wireApi: 'responses' | 'chat'; reasoningEfforts: string[] }> {
    await this.ready
    const draft = this.draft(input)
    let rows: unknown[] = []
    const supportedEndpoints: CustomEndpoint[] = []
    try {
      const response = await this.fetcher(`${draft.baseUrl}/models`, { headers: { Authorization: `Bearer ${draft.apiKey}` }, signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        const data = await response.json() as { data?: unknown[] }
        if (Array.isArray(data.data)) { rows = data.data.slice(0, 2000); supportedEndpoints.push('/v1/models') }
      }
    } catch (error) {
      if (!draft.model) throw new Error('模型目录不可用，请填写模型名')
    }
    const models = rows.map(row => normalizeModelCapability(row, 'custom')).filter((row): row is NonNullable<typeof row> => !!row).map(row => ({ ...row, efforts: row.efforts || [], serviceTiers: row.serviceTiers || [] }))
    if (!draft.model) draft.model = models[0]?.id || ''
    if (!draft.model) throw new Error('模型目录不可用，请填写模型名')
    if (!models.some(row => row.id === draft.model)) models.unshift({ ...normalizeModelCapability(draft.model, 'custom')!, efforts: [], serviceTiers: [] })
    const protocols = ['responses', 'chat'] as const
    const probeBodies = {
      responses: { model: draft.model, input: 'hi', stream: false, max_output_tokens: 16 },
      chat: { model: draft.model, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 16 },
    } satisfies Record<(typeof protocols)[number], Record<string, unknown>>
    const probeOnce = async (protocol: (typeof protocols)[number], body: Record<string, unknown>) => {
      const response = await this.fetcher(`${draft.baseUrl}/${protocol === 'chat' ? 'chat/completions' : 'responses'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${draft.apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify(body),
      })
      const text = await response.text().catch(() => '')
      let parsed: any = null
      try { parsed = JSON.parse(text) } catch { /* non-JSON bodies only count as served when the shape check passes */ }
      const served = response.ok && (protocol === 'chat' ? Array.isArray(parsed?.choices) && parsed.choices.length > 0 : Array.isArray(parsed?.output) && parsed.status !== 'failed')
      return { served, text }
    }
    const probes = await Promise.allSettled(protocols.map(protocol => probeOnce(protocol, probeBodies[protocol])))
    probes.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.served) supportedEndpoints.push(protocols[index] === 'responses' ? '/v1/responses' : '/v1/chat/completions')
    })
    if (!supportedEndpoints.some(endpoint => endpoint !== '/v1/models')) throw new Error('连接测试失败，请检查地址、模型和凭据')
    const wireApi = supportedEndpoints.includes('/v1/responses') ? 'responses' : 'chat'
    // The runtime only speaks the resolved wire, so effort probing targets it.
    // Every level starts as supported; a level is dropped only when the
    // upstream rejects it with an error naming the reasoning parameter —
    // silent ignores and unrelated failures cannot prove anything.
    const levelProbes = await Promise.all(customReasoningEffortLevels.map(async level => {
      try {
        const body = wireApi === 'chat' ? { ...probeBodies.chat, reasoning_effort: level } : { ...probeBodies.responses, reasoning: { effort: level } }
        const outcome = await probeOnce(wireApi, body)
        return { level, rejected: !outcome.served && /reasoning/i.test(outcome.text) }
      } catch {
        // A probe that could not run is no evidence of rejection; keep the level.
        return { level, rejected: false }
      }
    }))
    const reasoningEfforts = levelProbes.filter(row => !row.rejected).map(row => row.level)
    const token = randomBytes(24).toString('hex')
    for (const [key, proof] of this.proofs) if (proof.expires < Date.now()) this.proofs.delete(key)
    if (this.proofs.size >= 32) this.proofs.delete(this.proofs.keys().next().value!)
    this.proofs.set(token, { digest: this.digest(draft), models, supportedEndpoints, wireApi, reasoningEfforts, testedAt: new Date().toISOString(), expires: Date.now() + 10 * 60000 })
    return { token, models, model: draft.model, supportedEndpoints, wireApi, reasoningEfforts }
  }
  async save(input: CustomConnectionDraft, token: string): Promise<void> {
    await this.ready
    const draft = this.draft(input)
    // Save must diff and extend the raw stored row; the public get() returns
    // the materialized view with declared efforts merged in.
    const previous = draft.storageId ? this.state.connections.find(row => row.storageId === draft.storageId) : undefined
    const proof = this.proofs.get(token)
    const proofValid = !!proof && proof.expires >= Date.now() && proof.digest === this.digest(draft)
    // Local-only fields (the protocol bridge toggle) do not touch what a test
    // proves, so they may be saved without a fresh probe. Any credential
    // change, or a fresh probe result, always goes through the proof path.
    const onlyLocalChanges = !proofValid && !!previous
      && previous.alias === draft.alias && previous.provider === draft.provider
      && previous.baseUrl === draft.baseUrl && previous.model === draft.model
      && previous.apiKey === draft.apiKey
    if (!proofValid && !onlyLocalChanges) throw new Error('请先测试连接')
    if (!previous && this.state.connections.length >= 32) throw new Error('自定义连接数量已达上限')
    // Probed reasoning efforts come from a fresh proof; a no-probe save keeps
    // the previous verdicts untouched — only 重新测试连接 refreshes them.
    await this.mutate(() => {
      const row: StoredConnection = proofValid && proof
        ? { ...draft, reasoningEfforts: proof.reasoningEfforts, wireApi: proof.wireApi, protocolBridge: draft.protocolBridge === true, supportedEndpoints: proof.supportedEndpoints, testedAt: proof.testedAt, storageId: previous?.storageId || randomBytes(32).toString('hex'), revision: (previous?.revision || 0) + 1, models: proof.models, runtimeToken: randomBytes(24).toString('hex') }
        : { ...previous!, ...draft, protocolBridge: draft.protocolBridge === true, wireApi: previous!.wireApi, supportedEndpoints: previous!.supportedEndpoints, testedAt: previous!.testedAt, models: previous!.models, storageId: previous!.storageId, revision: previous!.revision + 1, runtimeToken: randomBytes(24).toString('hex') }
      // Editing an existing connection keeps its position so the settings list does not reorder under the pointer.
      const connections = previous
        ? this.state.connections.map(item => (item.storageId === row.storageId ? row : item))
        : [...this.state.connections, row]
      // An active connection that can no longer serve Codex (chat without the
      // bridge) is deselected, matching the pre-bridge save semantics.
      const unusableActive = this.state.activeId === row.storageId && row.wireApi !== 'responses' && !row.protocolBridge
      return { ...this.state, ...(unusableActive ? { activeId: null, explicitSelection: true } : {}), connections }
    })
    if (proofValid && proof) this.proofs.delete(token)
  }
  async select(id: string | null): Promise<void> {
    await this.mutate(() => {
      if (id && !this.get(id)) throw new Error('自定义连接已移除')
      if (id && this.get(id)!.wireApi === 'chat' && !this.get(id)!.protocolBridge) throw new Error('该连接仅支持 Chat Completions，可在账号设置中开启协议转换')
      return { ...this.state, activeId: id, explicitSelection: true }
    })
  }
  async remove(id: string): Promise<void> {
    await this.mutate(() => ({ ...this.state, activeId: this.state.activeId === id ? null : this.state.activeId, connections: this.state.connections.filter(row => row.storageId !== id) }))
  }
}
// Vite retains the shared execution bridge across reloads; its store must share the same identity.
const storeScope = globalThis as typeof globalThis & { __codexCustomConnectionStores?: Map<string, CustomConnectionStore> }
const stores = storeScope.__codexCustomConnectionStores ??= new Map<string, CustomConnectionStore>()
export function getCustomConnectionStore(home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): CustomConnectionStore {
  let store = stores.get(home)
  if (!store) { store = new CustomConnectionStore(home); stores.set(home, store) }
  return store
}
export function customRuntimeConfig(connection: NonNullable<ReturnType<CustomConnectionStore['get']>>, port: number) {
  // Codex always speaks Responses to the local runtime route; chat-only
  // connections need the protocol bridge toggle to serve it.
  if (connection.wireApi !== 'responses' && !connection.protocolBridge) throw new Error('Codex 需要 Responses API，可在账号设置中开启协议转换')
  const provider = `custom_${connection.storageId}`
  return { args: ['-c', `model_provider=${JSON.stringify(provider)}`, '-c', `model=${JSON.stringify(connection.model)}`,
    '-c', `model_providers.${provider}.name="Custom connection"`, '-c', `model_providers.${provider}.base_url="http://127.0.0.1:${port}/codex-api/custom-connections/runtime/${connection.storageId}/${connection.revision}/v1"`,
    '-c', `model_providers.${provider}.wire_api="responses"`, '-c', `model_providers.${provider}.env_key="CODEXAPP_CUSTOM_RUNTIME_TOKEN"`, '-c', `model_providers.${provider}.requires_openai_auth=false`],
    env: { CODEXAPP_CUSTOM_RUNTIME_TOKEN: connection.runtimeToken } }
}
