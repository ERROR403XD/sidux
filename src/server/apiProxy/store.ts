import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class ProxyError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
  }
}
export type ProxySettings = {
  enabled: boolean
  accountStorageId: string | null
  globalConcurrency: number
  keyConcurrency: number
  drainTimeoutSeconds: number
}
export type ProxyKey = {
  accountStorageId?: string | null
  protected?: boolean
  id: string
  name: string
  suffix: string
  hash: string
  enabled: boolean
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}
type State = { version: 1; settings: ProxySettings; keys: ProxyKey[] }
export const defaultSettings: ProxySettings = {
  enabled: false,
  accountStorageId: null,
  globalConcurrency: 8,
  keyConcurrency: 4,
  drainTimeoutSeconds: 60,
}
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export async function privateJson(path: string, value: unknown, compact = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, compact ? undefined : 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}
export class ProxyStore {
  private state: State = { version: 1, settings: { ...defaultSettings }, keys: [] }
  private serial: Promise<unknown> = Promise.resolve()
  private flushTimer: NodeJS.Timeout | null = null
  readonly ready: Promise<void>
  constructor(readonly directory: string) {
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    let text: string
    try {
      text = await readFile(join(this.directory, 'state.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state = JSON.parse(text) as State
    if (state.version !== 1 || !Array.isArray(state.keys) || state.keys.length > 256 || !state.settings) {
      throw new ProxyError('invalid_state', 'API 出口状态文件无效。', 503)
    }
    this.validateSettings(state.settings)
    for (const key of state.keys) {
      if (!/^[a-f0-9]{64}$/.test(key.hash) || typeof key.id !== 'string' || typeof key.enabled !== 'boolean'
        || (key.expiresAt !== null && !Number.isFinite(Date.parse(key.expiresAt)))) {
        throw new ProxyError('invalid_state', 'API key 状态文件无效。', 503)
      }
    }
    for (const key of state.keys) {
      this.validateKeyPolicy(key)
    }
    this.state = state
  }
  get settings(): ProxySettings { return { ...this.state.settings } }
  listKeys(): Omit<ProxyKey, 'hash'>[] {
    return this.state.keys.map(({ hash: _hash, ...key }) => ({ ...key }))
  }
  findKey(id: string): ProxyKey | undefined { return this.state.keys.find(key => key.id === id) }
  isKeyUsable(id: string): boolean {
    const key = this.findKey(id)
    return !!key && key.enabled && !key.revokedAt && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now())
  }
  authenticate(secret: string): ProxyKey | null {
    const id = /^cax_([a-f0-9]{16})_/.exec(secret)?.[1]
    const key = id ? this.findKey(id) : undefined
    const matches = timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.from(key?.hash ?? '0'.repeat(64), 'hex'))
    if (!key || !matches || !this.isKeyUsable(key.id)) return null
    return key
  }
  validateSettings(settings: ProxySettings): void {
    if (typeof settings.enabled !== 'boolean' || (settings.accountStorageId !== null && typeof settings.accountStorageId !== 'string')) {
      throw new ProxyError('invalid_settings', '出口设置格式错误。')
    }
    for (const [name, max] of [['globalConcurrency', 64], ['keyConcurrency', 32], ['drainTimeoutSeconds', 300]] as const) {
      const value = settings[name]
      if (!Number.isInteger(value) || value < 1 || value > max) throw new ProxyError('invalid_settings', `${name} 必须在 1–${max} 之间。`)
    }
  }
  validateKeyPolicy(input: { accountStorageId?: unknown; protected?: unknown }): void {
    if (input.accountStorageId !== undefined && input.accountStorageId !== null && (typeof input.accountStorageId !== 'string' || !/^[a-f0-9]{64}$/.test(input.accountStorageId))) throw new ProxyError('invalid_account', '账号选择无效。')
    if (input.protected !== undefined && typeof input.protected !== 'boolean') throw new ProxyError('invalid_protection', '保护开关无效。')
  }
  private mutate<T>(operation: (next: State) => T): Promise<T> {
    const next = this.serial.then(async () => {
      await this.ready
      const snapshot = structuredClone(this.state)
      const result = operation(snapshot)
      await privateJson(join(this.directory, 'state.json'), snapshot)
      this.state = snapshot
      return result
    })
    this.serial = next.catch(() => undefined)
    return next
  }
  async saveSettings(settings: ProxySettings): Promise<void> {
    this.validateSettings(settings)
    await this.mutate(next => { next.settings = { ...settings } })
  }
  async createKey(name: string, expiresAt: string | null, policy: Pick<ProxyKey, 'accountStorageId' | 'protected'> = {}): Promise<{ key: Omit<ProxyKey, 'hash'>; secret: string }> {
    this.validateKeyPolicy(policy)
    if (!name.trim() || name.length > 80) throw new ProxyError('invalid_key_name', '名称须为 1–80 个字符。')
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      throw new ProxyError('invalid_expiry', '到期时间必须晚于现在。')
    }
    const id = randomBytes(8).toString('hex')
    const secret = `cax_${id}_${randomBytes(32).toString('base64url')}`
    const key: ProxyKey = { accountStorageId: policy.accountStorageId ?? null, protected: policy.protected ?? false, id, name: name.trim(), suffix: secret.slice(-4), hash: hashSecret(secret), enabled: true,
      createdAt: new Date().toISOString(), expiresAt, revokedAt: null, lastUsedAt: null }
    await this.mutate(next => {
      if (next.keys.length >= 256) throw new ProxyError('key_limit', '最多保留 256 把 key。')
      next.keys.push(key)
    })
    const { hash: _hash, ...publicKey } = key
    return { key: publicKey, secret }
  }
  async updateKey(id: string, input: { name?: string; enabled?: boolean; revoke?: boolean; expiresAt?: string | null; accountStorageId?: string | null; protected?: boolean }): Promise<void> {
    await this.mutate(next => {
      const key = next.keys.find(item => item.id === id)
      if (!key) throw new ProxyError('key_not_found', 'API key 不存在。', 404)
      this.validateKeyPolicy(input)
      if (input.accountStorageId !== undefined) key.accountStorageId = input.accountStorageId
      if (input.protected !== undefined) key.protected = input.protected
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new ProxyError('invalid_key_name', '名称须为 1–80 个字符。')
        key.name = input.name.trim()
      }
      if (input.expiresAt !== undefined) {
        if (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) throw new ProxyError('invalid_expiry', '无效的到期时间。')
        key.expiresAt = input.expiresAt
      }
      if (typeof input.enabled === 'boolean' && !key.revokedAt) key.enabled = input.enabled
      if (input.revoke) {
        key.revokedAt = new Date().toISOString()
        key.enabled = false
      }
    })
  }
  touch(id: string): void {
    const key = this.findKey(id)
    if (key) key.lastUsedAt = new Date().toISOString()
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.mutate(() => undefined).catch(() => undefined)
    }, 2000)
    this.flushTimer.unref()
  }
  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    await this.mutate(() => undefined)
  }
}
