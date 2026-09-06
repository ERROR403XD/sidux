import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import manifest from '../../../resources/api-proxy/manifest.json'
import type { AccountAuthCoordinator } from '../accountAuthCoordinator.js'
import { privateJson, ProxyError } from './store.js'

export { manifest as proxyManifest }
export type ComponentGeneration = {
  id: string
  url: string
  key: string
  storageId: string
  revision: number
  expiresAt: string
  references: number
  process: ChildProcess
  directory: string
}
async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
export class ProxyComponent {
  private current: ComponentGeneration | null = null
  private readonly generations = new Set<ComponentGeneration>()
  private flight: Promise<ComponentGeneration> | null = null
  private checkedAt = 0
  private retryAfter = 0
  private failures = 0
  lastError: string | null = null
  readonly binary = process.env.CODEXAPP_API_PROXY_BINARY || '/opt/codexapp-api-proxy/cli-proxy-api'
  constructor(private directory: string, private coordinator: AccountAuthCoordinator) {}
  async available(): Promise<boolean> { return access(this.binary).then(() => true, () => false) }
  status() {
    const current = this.current
    return { ready: !!current && current.process.exitCode === null && current.process.signalCode === null,
      componentVersion: manifest.version, selectedStorageId: current?.storageId ?? null,
      credentialRevision: current?.revision ?? null, lastError: this.lastError }
  }
  async prepare(storageId: string | null): Promise<ComponentGeneration> {
    if (this.flight) return await this.flight
    const current = this.current
    if (current && current.process.exitCode === null && current.process.signalCode === null && !this.coordinator.isAccountOperationInProgress()
      && Date.now() - this.checkedAt < 10_000 && Date.parse(current.expiresAt) > Date.now() + 300_000) return current
    if (Date.now() < this.retryAfter) throw new ProxyError('component_backoff', '组件暂时不可用，请稍后重试。', 503)
    const flight = this.prepareNext(storageId)
    this.flight = flight
    try { return await flight } finally { this.flight = null }
  }
  private async prepareNext(storageId: string | null): Promise<ComponentGeneration> {
    try {
      const credential = await this.coordinator.getApiCredential(storageId)
      const current = this.current
      if (current && current.storageId === credential.storageId && current.revision === credential.revision
        && current.process.exitCode === null && current.process.signalCode === null) {
        this.checkedAt = Date.now()
        return current
      }
      for (const generation of this.generations) {
        if (generation !== current && generation.references === 0) await this.stopGeneration(generation)
      }
      if (this.generations.size >= 2) throw new ProxyError('credential_drain_required', '旧凭据连接仍在使用，请等待或关闭旧连接后重试。', 503)
      const binary = await readFile(this.binary).catch(() => { throw new ProxyError('component_missing', '反代组件未安装。', 503) })
      if (createHash('sha256').update(binary).digest('hex') !== manifest.binarySha256) {
        throw new ProxyError('component_checksum', '反代组件校验失败。', 503)
      }
      const id = randomUUID()
      const directory = join(this.directory, 'runtime', id)
      const authDirectory = join(directory, 'auth')
      await mkdir(authDirectory, { recursive: true, mode: 0o700 })
      const port = await freePort()
      const key = randomBytes(32).toString('hex')
      await privateJson(join(authDirectory, 'selected.json'), { type: 'codex', access_token: credential.accessToken,
        account_id: credential.accountId, expired: credential.expiresAt, websockets: true })
      await privateJson(join(directory, 'config.yaml'), {
        host: '127.0.0.1', port, 'auth-dir': authDirectory, 'api-keys': [key],
        'remote-management': { 'secret-key': '', 'disable-control-panel': true, 'disable-auto-update-panel': true },
        'commercial-mode': true, 'logging-to-file': false, 'request-log': false,
        'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0,
        'quota-exceeded': { 'switch-project': false, 'switch-preview-model': false },
        'ws-auth': true, 'usage-statistics-enabled': false, 'disable-image-generation': 'passthrough',
        plugins: { enabled: false }, routing: { strategy: 'fill-first', 'session-affinity': false },
        streaming: { 'bootstrap-retries': 0 }, codex: { 'stream-bootstrap-buffering': false, 'optimize-multi-agent-v2': false },
      })
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory }
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) if (process.env[name]) env[name] = process.env[name]
      const child = spawn(this.binary, ['-local-model', '-config', join(directory, 'config.yaml')], { cwd: directory, env, stdio: 'ignore' })
      const generation: ComponentGeneration = { id, url: `http://127.0.0.1:${port}`, key, storageId: credential.storageId,
        revision: credential.revision, expiresAt: credential.expiresAt, references: 0, process: child, directory }
      this.generations.add(generation)
      let spawnFailed = false
      child.on('error', () => { spawnFailed = true })
      let ready = false
      for (let i = 0; i < 60; i++) {
        if (spawnFailed || child.exitCode !== null || child.signalCode !== null) break
        try {
          const response = await fetch(`${generation.url}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(500) })
          const body = await response.json() as { data?: unknown[] }
          if (response.ok && Array.isArray(body.data) && body.data.length > 0) { ready = true; break }
        } catch { /* Bounded startup readiness. */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!ready) {
        await this.stopGeneration(generation)
        throw new ProxyError('component_start_failed', '反代组件未能就绪。', 503)
      }
      this.current = generation
      this.checkedAt = Date.now()
      this.failures = 0
      this.lastError = null
      if (current && current.references === 0) await this.stopGeneration(current)
      return generation
    } catch (error) {
      this.lastError = error instanceof ProxyError ? error.message : '账号或组件准备失败。'
      this.retryAfter = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5))
      throw error
    }
  }
  hold(generation: ComponentGeneration): () => void {
    generation.references++
    let released = false
    return () => {
      if (released) return
      released = true
      generation.references--
      if (generation !== this.current && generation.references === 0) void this.stopGeneration(generation).catch(() => undefined)
    }
  }
  private async stopGeneration(generation: ComponentGeneration): Promise<void> {
    const child = generation.process
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => undefined)
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))])
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))])
      }
      if (child.exitCode === null && child.signalCode === null) throw new ProxyError('component_stop_failed', '无法确认反代组件退出。', 503)
    }
    this.generations.delete(generation)
    await rm(generation.directory, { recursive: true, force: true })
  }
  async stop(): Promise<void> {
    if (this.flight) await this.flight.catch(() => undefined)
    for (const generation of this.generations) await this.stopGeneration(generation)
    this.current = null
    this.checkedAt = 0
    this.retryAfter = 0
  }
}
