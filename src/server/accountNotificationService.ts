import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultNotificationSettings, defaultNoticeRule, inQuietHours, renderNotice, renderNoticeBody, validateNotificationSettings, type NotificationSettings, type AccountNoticeRule } from '../accountNotifications.js'
import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import type { StoredAccountEntry } from './accountAuthStore.js'
import { privateJson } from './apiProxy/store.js'

type WindowState = { reset: number; used: number }
type PendingNotice = { id: string; accountId: string; kind: 'fiveHour' | 'weekly'; message: string; createdAt: number }
type State = { version: 1; settings: NotificationSettings; accounts: Record<string, AccountNoticeRule>; windows: Record<string, WindowState>; pending: PendingNotice[]; lastResult: string | null }
export class AccountNotificationService {
  private state: State = { version: 1, settings: { ...defaultNotificationSettings }, accounts: {}, windows: {}, pending: [], lastResult: null }
  readonly ready: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  private ticking: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly path: string
  constructor(private coordinator: AccountAuthCoordinator, private fetchImpl: typeof fetch = fetch, autoStart = true, private activeAccounts: () => Promise<string[]> = async () => []) {
    const directory = join(coordinator.store.codexHome, 'account-notifications')
    const statePath = join(directory, 'state.json')
    this.path = statePath
    this.ready = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        const data = JSON.parse(await readFile(statePath, 'utf8'))
        if (data.version !== 1) throw new Error('通知状态版本无效')
        this.state = { ...this.state, ...data, settings: validateNotificationSettings(data.settings) }
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    })()
    void this.ready.catch(() => undefined)
    if (autoStart) {
      this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, 30_000)
      this.timer.unref()
    }
  }
  private mutate<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.serial.then(async () => {
      await this.ready
      const next = structuredClone(this.state)
      const result = await fn(next)
      await privateJson(this.path, next)
      this.state = next
      return result
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }
  async setTimezone(timezone: string): Promise<void> {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    await this.mutate(state => { state.settings.timezone = timezone })
  }
  async snapshot() {
    await this.ready
    return { settings: { ...this.state.settings }, accounts: structuredClone(this.state.accounts), pendingCount: this.state.pending.length, lastResult: this.state.lastResult }
  }
  async save(input: { settings?: NotificationSettings; accountId?: string; rule?: AccountNoticeRule; protectionPercent?: number }) {
    if (input.settings) validateNotificationSettings(input.settings)
    if (input.accountId) {
      if (!(await this.coordinator.store.readState()).accounts.some(account => account.storageId === input.accountId)) throw new Error('账号不存在。')
      const rule = input.rule
      if (!rule || typeof rule.fiveHour !== 'boolean' || typeof rule.weekly !== 'boolean' || typeof rule.fiveHourMessage !== 'string' || typeof rule.weeklyMessage !== 'string') throw new Error('账号通知规则无效。')
    }
    if (input.protectionPercent !== undefined) {
      if (!input.accountId || !Number.isFinite(input.protectionPercent) || input.protectionPercent < 0 || input.protectionPercent > 100) throw new Error('账号周保护值须为0–100。')
      await this.coordinator.store.updateState(state => ({ state: { ...state, accounts: state.accounts.map(account => account.storageId === input.accountId ? { ...account, protectionPercent: input.protectionPercent } : account) }, result: undefined }))
    }
    await this.mutate(state => {
      if (input.settings) state.settings = { ...input.settings }
      if (input.accountId && input.rule) state.accounts[input.accountId] = { ...input.rule }
      state.pending = state.pending.filter(item => state.settings.enabled && state.accounts[item.accountId]?.[item.kind])
    })
    return this.snapshot()
  }
  async observe(account: StoredAccountEntry): Promise<void> {
    if (this.stopped || account.quotaStatus !== 'ready' || !account.quotaSnapshot) return
    await this.mutate(state => {
      const rule = state.accounts[account.storageId] || defaultNoticeRule
      for (const window of [account.quotaSnapshot?.primary, account.quotaSnapshot?.secondary]) {
        const kind = window?.windowMinutes === 300 ? 'fiveHour' : window?.windowMinutes === 10080 ? 'weekly' : null
        if (!kind || !window?.resetsAt) continue
        const key = `${account.storageId}:${kind}`
        const old = state.windows[key]
        const recovered = !!old && window.resetsAt > old.reset && window.usedPercent < old.used
        state.windows[key] = { reset: window.resetsAt, used: window.usedPercent }
        if (!state.settings.enabled || !rule[kind] || !recovered) continue
        const resetAt = new Intl.DateTimeFormat('zh-CN', { timeZone: state.settings.timezone, dateStyle: 'short', timeStyle: 'short' }).format(window.resetsAt * 1000)
        const values = { account: account.email || account.accountId, account_id: account.storageId, window: kind === 'fiveHour' ? '5小时' : '周', remaining: String(Math.round(100 - window.usedPercent)), reset_at: resetAt }
        state.pending.push({ id: randomUUID(), accountId: account.storageId, kind, message: renderNotice(kind === 'fiveHour' ? rule.fiveHourMessage : rule.weeklyMessage, values), createdAt: Date.now() })
      }
      state.pending = state.pending.filter(item => Date.now() - item.createdAt < 7 * 86400_000).slice(-256)
    })
  }
  async flush(now = Date.now()): Promise<void> {
    await this.ready
    if (!this.state.settings.enabled || !this.state.pending.length || inQuietHours(this.state.settings, now)) return
    // Remove durably before POST: an ambiguous delivery must not send duplicates after restart.
    const notices = await this.mutate(state => {
      if (!state.settings.enabled || inQuietHours(state.settings, now)) return []
      state.pending = state.pending.filter(item => now - item.createdAt < 7 * 86400_000)
      return state.pending.splice(0, 16).map(item => ({ ...item, settings: { ...state.settings } }))
    })
    for (const item of notices) {
      let result = '发送结果未确认，不自动重试'
      try {
        const response = await this.fetchImpl(item.settings.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodexApp-Notification-Id': item.id }, body: renderNoticeBody(item.settings.body, { message: item.message, account_id: item.accountId }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
        await response.body?.cancel()
        result = response.ok ? '通知已发送' : `通知失败：HTTP ${response.status}`
      } catch { /* Do not retain URL, body, credentials, or remote error text. */ }
      await this.mutate(state => { state.lastResult = result })
    }
  }
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.ticking) return this.ticking
    this.ticking = (async () => {
      await this.ready
      const accounts = (await this.coordinator.store.readState()).accounts
      const active = new Set(await this.activeAccounts())
      for (const account of accounts) {
        if (this.stopped || this.coordinator.isAccountOperationInProgress()) break
        if (['reauth_required', 'materialization_dirty'].includes(account.authStatus)) continue
        const maxAge = active.has(account.storageId) && account.protectionPercent ? 30_000 : 5 * 60_000
        if (!account.quotaUpdatedAtIso || !Number.isFinite(Date.parse(account.quotaUpdatedAtIso)) || Date.now() - Date.parse(account.quotaUpdatedAtIso) >= maxAge) await this.coordinator.refreshAccount(account.storageId).catch(() => undefined)
      }
      await this.flush()
    })().finally(() => { this.ticking = null })
    return this.ticking
  }
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.ticking
    await this.serial
  }
}
