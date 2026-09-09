import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultNotificationSettings, defaultNoticeRule, normalizeNoticeRule, mainQuotaWording, parseResetExpiryLeadTimes, formatReminderHours, inQuietHours, renderNotice, renderNoticeBody, validateNotificationSettings, type NotificationSettings, type AccountNoticeRule } from '../accountNotifications.js'
import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import type { StoredAccountEntry } from './accountAuthStore.js'
import { normalizeResetCredits } from '../accountResetCredits.js'
import { quotaRefreshInterval } from '../quotaRefresh.js'
import { privateJson } from './apiProxy/store.js'

type WindowState = { reset: number; used: number }
type PendingNotice = { id: string; accountId: string; kind: 'fiveHour' | 'weekly' | 'resetExpiry' | 'resetIncrease'; message: string; createdAt: number; expiresAt?: number; creditId?: string; values?: Record<string, string> }
type ResetCountState = { count: number; observedAt: number | null }
type State = { resetCounts: Record<string, ResetCountState>; expiryNotices: Record<string, number>; version: 1; settings: NotificationSettings; accounts: Record<string, AccountNoticeRule>; windows: Record<string, WindowState>; pending: PendingNotice[]; lastResult: string | null }
export class AccountNotificationService {
  private state: State = { resetCounts: {}, expiryNotices: {}, version: 1, settings: { ...defaultNotificationSettings }, accounts: {}, windows: {}, pending: [], lastResult: null }
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
        this.state = { ...this.state, ...data, resetCounts: data.resetCounts || {}, settings: validateNotificationSettings(data.settings) }
        this.state.accounts = Object.fromEntries(Object.entries(this.state.accounts).map(([id, rule]) => [id, normalizeNoticeRule(rule)]))
        this.state.pending = this.state.pending.map(notice => ({ ...notice, message: mainQuotaWording(notice.message) }))
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    })()
    void this.ready.catch(() => undefined)
    if (autoStart) {
      this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, 5000)
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
  async save(input: { settings?: NotificationSettings; accountId?: string; rule?: AccountNoticeRule; protectionPercent?: number; alias?: string }) {
    if (input.settings) validateNotificationSettings(input.settings)
    const accounts = input.accountId || input.settings?.enabled ? (await this.coordinator.store.readState()).accounts : []
    if (input.accountId) {
      if (!accounts.some(account => account.storageId === input.accountId)) throw new Error('账号不存在。')
      const rule = input.rule
      if (!rule || typeof rule.fiveHour !== 'boolean' || typeof rule.weekly !== 'boolean' || typeof rule.fiveHourMessage !== 'string' || typeof rule.weeklyMessage !== 'string') throw new Error('账号通知规则无效。')
    }
    if (input.rule) normalizeNoticeRule(input.rule)
    if (input.protectionPercent !== undefined) {
      if (!input.accountId || !Number.isFinite(input.protectionPercent) || input.protectionPercent < 0 || input.protectionPercent > 100) throw new Error('账号保护值须为0–100。')
    }
    if (input.alias !== undefined && (!input.accountId || typeof input.alias !== 'string' || input.alias.trim().length > 80)) {
      throw new Error('账号别名须为不超过80个字符的文本。')
    }
    let protectionChanged = false
    if (input.protectionPercent !== undefined || input.alias !== undefined) {
      // Metadata shares the store's short write queue, never the login/switch/runtime gate.
      protectionChanged = await this.coordinator.store.updateState(state => {
        const current = state.accounts.find(account => account.storageId === input.accountId)
        if (!current) throw new Error('账号不存在。')
        const accounts = state.accounts.map(account => account.storageId === input.accountId ? {
          ...account,
          ...(input.protectionPercent !== undefined ? { protectionPercent: input.protectionPercent } : {}),
          ...(input.alias !== undefined ? { alias: input.alias.trim() } : {}),
        } : account)
        return { state: { ...state, accounts }, result: input.protectionPercent !== undefined && input.protectionPercent !== (current.protectionPercent || 0) }
      })
    }
    await this.mutate(state => {
      // Enabling begins from the current known count, not increases that happened while disabled.
      const newlyEnabled = input.settings?.enabled && !state.settings.enabled
      for (const account of accounts) {
        const ruleEnabled = input.accountId === account.storageId && input.rule?.resetIncrease && !state.accounts[account.storageId]?.resetIncrease
        const baseline = this.resetCount(account)
        if (baseline && (newlyEnabled || ruleEnabled)) state.resetCounts[account.storageId] = baseline
      }
      if (input.settings) state.settings = { ...input.settings }
      if (input.accountId && input.rule) state.accounts[input.accountId] = normalizeNoticeRule(input.rule)
      state.pending = state.pending.filter(item => state.settings.enabled && state.accounts[item.accountId]?.[item.kind])
    })
    return { ...await this.snapshot(), protectionChanged }
  }
  async test(): Promise<{ lastResult: string | null }> {
    await this.ready
    const settings = { ...this.state.settings }
    if (!settings.enabled || !settings.url) throw new Error('请先启用并保存通知配置。')
    let result = '测试发送结果未确认'
    try {
      const response = await this.fetchImpl(settings.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: renderNoticeBody(settings.body, { message: 'CodexApp 通知测试：额度恢复通知渠道测试，此消息不代表真实额度重置。', account_id: '' }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
      await response.body?.cancel()
      result = response.ok ? '测试通知已发送' : `测试通知失败：HTTP ${response.status}`
    } catch { /* Keep endpoint credentials and remote error payloads private. */ }
    await this.mutate(state => { state.lastResult = result })
    return { lastResult: result }
  }
  private resetCount(account: StoredAccountEntry): ResetCountState | null {
    if (account.quotaStatus !== 'ready') return null
    const credits = normalizeResetCredits(account.resetCredits)
    if (!credits) return null
    const timestamp = Date.parse(account.quotaUpdatedAtIso || account.lastVerifiedAtIso || '')
    return { count: credits.availableCount, observedAt: Number.isFinite(timestamp) ? timestamp : null }
  }
  async observe(account: StoredAccountEntry): Promise<void> {
    if (this.stopped || account.quotaStatus !== 'ready') return
    await this.mutate(state => {
      const rule = state.accounts[account.storageId] || defaultNoticeRule
      const current = this.resetCount(account)
      const previous = state.resetCounts[account.storageId]
      const stale = current?.observedAt != null && previous?.observedAt != null && current.observedAt < previous.observedAt
      if (current && !stale) {
        state.resetCounts[account.storageId] = current
        if (state.settings.enabled && rule.resetIncrease && previous && current.count > previous.count) {
          const values = {
            account: account.email || account.accountId,
            account_id: account.storageId,
            increase: String(current.count - previous.count),
            previous: String(previous.count),
            remaining: String(current.count),
          }
          state.pending.push({
            id: randomUUID(), accountId: account.storageId, kind: 'resetIncrease',
            message: renderNotice(rule.resetIncreaseMessage || defaultNoticeRule.resetIncreaseMessage!, values),
            values, createdAt: Date.now(),
          })
        }
      }
      for (const window of [account.quotaSnapshot?.primary, account.quotaSnapshot?.secondary]) {
        const kind = window?.windowMinutes === 300 ? 'fiveHour' : window && window.windowMinutes !== null && window.windowMinutes >= 10080 ? 'weekly' : null
        if (!kind || !window || !Number.isFinite(window.usedPercent)) continue
        const key = `${account.storageId}:${kind}`
        const old = state.windows[key]
        const resetUsedAt = Date.parse(account.lastResetUsedAtIso || '')
        const recentlyUsedReset = Number.isFinite(resetUsedAt) && Date.now() - resetUsedAt < 10 * 60_000
        const recovered = !!old && old.used - window.usedPercent >= 45 - Number.EPSILON * 100 && !recentlyUsedReset
        state.windows[key] = { reset: window.resetsAt || 0, used: window.usedPercent }
        if (!state.settings.enabled || !rule[kind] || !recovered) continue
        const resetAt = window.resetsAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: state.settings.timezone, dateStyle: 'short', timeStyle: 'short' }).format(window.resetsAt * 1000) : '未知'
        const values = { account: account.email || account.accountId, account_id: account.storageId, window: kind === 'fiveHour' ? '5小时' : '主额度', remaining: String(Math.round(100 - window.usedPercent)), reset_at: resetAt }
        state.pending.push({ id: randomUUID(), accountId: account.storageId, kind, message: renderNotice(kind === 'fiveHour' ? rule.fiveHourMessage : rule.weeklyMessage, values), createdAt: Date.now() })
      }
      state.pending = state.pending.filter(item => Date.now() - item.createdAt < 7 * 86400_000).slice(-256)
    })
  }
  async checkExpiries(accounts: StoredAccountEntry[], now = Date.now()): Promise<void> {
    await this.ready
    if (!this.state.settings.enabled) return
    const candidates = accounts.flatMap(account => {
      const rule = this.state.accounts[account.storageId]
      if (!rule?.resetExpiry) return []
      const hours = parseResetExpiryLeadTimes(rule.resetExpiryLeadTimes!).hours
      return (account.resetCredits?.credits || []).flatMap(credit => {
        if (credit.status !== 'available' || !credit.expiresAt || credit.expiresAt * 1000 <= now) return []
        const expiresAt = credit.expiresAt * 1000
        const due = hours.filter(lead => now >= expiresAt - lead * 3600_000)
        return due.length ? [{ account, credit, expiresAt, due, rule }] : []
      })
    })
    const keyFor = (id: string, credit: string, expiry: number, lead: number) => JSON.stringify([id, credit, expiry, lead])
    const valid = (notice: PendingNotice) => notice.kind !== 'resetExpiry' || !!accounts.find(account => account.storageId === notice.accountId)?.resetCredits?.credits?.some(credit => credit.id === notice.creditId && credit.status === 'available' && credit.expiresAt! * 1000 === notice.expiresAt && notice.expiresAt! > now)
    const needed = candidates.some(row => row.due.some(lead => !this.state.expiryNotices[keyFor(row.account.storageId, row.credit.id, row.expiresAt, lead)]))
      || Object.values(this.state.expiryNotices).some(expiry => expiry <= now) || this.state.pending.some(notice => !valid(notice))
    if (!needed) return
    await this.mutate(state => {
      state.expiryNotices = Object.fromEntries(Object.entries(state.expiryNotices).filter(([, expiry]) => expiry > now))
      state.pending = state.pending.filter(valid)
      let ledgerSize = Object.keys(state.expiryNotices).length
      for (const row of candidates) {
        const fresh = row.due.filter(lead => !state.expiryNotices[keyFor(row.account.storageId, row.credit.id, row.expiresAt, lead)])
        if (!fresh.length || ledgerSize + fresh.length > 10000) continue
        // Catch up only the nearest crossed threshold after downtime or enabling.
        ledgerSize += fresh.length
        const lead = Math.min(...fresh)
        for (const value of fresh) state.expiryNotices[keyFor(row.account.storageId, row.credit.id, row.expiresAt, value)] = row.expiresAt
        const values = { account: row.account.email || row.account.accountId, account_id: row.account.storageId, credit_id: row.credit.id,
          expires_at: new Intl.DateTimeFormat('zh-CN', { timeZone: state.settings.timezone, dateStyle: 'short', timeStyle: 'short' }).format(row.expiresAt),
          remaining: formatReminderHours(Math.max(1, Math.ceil((row.expiresAt - now) / 3600_000))), lead_time: formatReminderHours(lead) }
        state.pending.push({ id: randomUUID(), accountId: row.account.storageId, kind: 'resetExpiry', creditId: row.credit.id, expiresAt: row.expiresAt,
          message: renderNotice(row.rule.resetExpiryMessage!, values), values, createdAt: now })
      }
      state.pending = state.pending.slice(-256)
    })
  }
  async flush(now = Date.now()): Promise<void> {
    await this.ready
    if (!this.state.settings.enabled || !this.state.pending.length || inQuietHours(this.state.settings, now)) return
    // Remove durably before POST: an ambiguous delivery must not send duplicates after restart.
    const notices = await this.mutate(state => {
      if (!state.settings.enabled || inQuietHours(state.settings, now)) return []
      state.pending = state.pending.filter(item => now - item.createdAt < 7 * 86400_000 && (!item.expiresAt || item.expiresAt > now))
      return state.pending.splice(0, 16).map(item => ({ ...item, settings: { ...state.settings } }))
    })
    for (const item of notices) {
      let result = '发送结果未确认，不自动重试'
      try {
        const response = await this.fetchImpl(item.settings.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodexApp-Notification-Id': item.id }, body: renderNoticeBody(item.settings.body, { ...item.values, message: item.message, account_id: item.accountId }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
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
      const state = await this.coordinator.store.readState()
      const accounts = state.accounts
      const active = new Set(await this.activeAccounts())
      if (state.activeStorageId) active.add(state.activeStorageId)
      for (const account of accounts) {
        if (this.stopped || this.coordinator.isAccountOperationInProgress()) break
        if (['reauth_required', 'materialization_dirty'].includes(account.authStatus)) continue
        const maxAge = active.has(account.storageId) ? quotaRefreshInterval(account.quotaSnapshot) : 5 * 60_000
        const updatedAt = account.lastVerifiedAtIso || account.quotaUpdatedAtIso
        if (!updatedAt || !Number.isFinite(Date.parse(updatedAt)) || Date.now() - Date.parse(updatedAt) >= maxAge) await this.coordinator.refreshAccount(account.storageId).catch(() => undefined)
      }
      await this.checkExpiries((await this.coordinator.store.readState()).accounts)
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
