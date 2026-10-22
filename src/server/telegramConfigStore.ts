import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultQuietHours, validateQuietHours, type QuietHoursSettings } from '../accountNotifications.js'
import { asRecord } from './httpUtils.js'
import { getCodexHomeDir } from './runtimePaths.js'

export type TelegramBridgeConfigState = QuietHoursSettings & {
  botToken: string
  notificationsEnabled: boolean
  chatIds: number[]
  allowedUserIds: Array<number | '*'>
}

export function normalizeTelegramBridgeConfig(value: unknown): TelegramBridgeConfigState {
  const record = asRecord(value)
  if (!record) return { ...defaultQuietHours, botToken: '', notificationsEnabled: false, chatIds: [], allowedUserIds: [] }
  const botToken = typeof record.botToken === 'string' ? record.botToken.trim() : ''
  const notificationsEnabled = typeof record.notificationsEnabled === 'boolean' ? record.notificationsEnabled : !!botToken
  const rawChatIds = Array.isArray(record.chatIds) ? record.chatIds : []
  const chatIds = Array.from(new Set(rawChatIds
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.trunc(value)))).slice(0, 50)
  const rawAllowedUserIds = Array.isArray(record.allowedUserIds) ? record.allowedUserIds : []
  const allowAllUsers = rawAllowedUserIds.some((value) => typeof value === 'string' && value.trim() === '*')
  const normalizedAllowedUserIds = Array.from(new Set(rawAllowedUserIds
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
      if (typeof value === 'string') {
        const normalized = value.trim().replace(/^(telegram|tg):/i, '').trim()
        if (/^-?\d+$/.test(normalized)) {
          return Number.parseInt(normalized, 10)
        }
      }
      return Number.NaN
    })
    .filter((value) => Number.isFinite(value)))).slice(0, 100)
  const allowedUserIds: Array<number | '*'> = allowAllUsers
    ? ['*' as const, ...normalizedAllowedUserIds]
    : normalizedAllowedUserIds
  const quietHours = validateQuietHours({
    timezone: typeof record.timezone === 'string' ? record.timezone : defaultQuietHours.timezone,
    quietEnabled: typeof record.quietEnabled === 'boolean' ? record.quietEnabled : false,
    quietStart: typeof record.quietStart === 'string' ? record.quietStart : defaultQuietHours.quietStart,
    quietEnd: typeof record.quietEnd === 'string' ? record.quietEnd : defaultQuietHours.quietEnd,
  })
  return { ...quietHours, botToken, notificationsEnabled, chatIds, allowedUserIds }
}

export function getTelegramBridgeConfigPath(): string {
  return join(getCodexHomeDir(), 'telegram-bridge.json')
}

export async function readTelegramBridgeConfig(): Promise<TelegramBridgeConfigState> {
  try {
    const raw = await readFile(getTelegramBridgeConfigPath(), 'utf8')
    return normalizeTelegramBridgeConfig(asRecord(JSON.parse(raw)) ?? {})
  } catch {
    return { ...defaultQuietHours, botToken: '', notificationsEnabled: false, chatIds: [], allowedUserIds: [] }
  }
}

export async function writeTelegramBridgeConfig(nextState: TelegramBridgeConfigState): Promise<void> {
  const normalized = normalizeTelegramBridgeConfig(nextState)
  await writeFile(getTelegramBridgeConfigPath(), JSON.stringify(normalized), 'utf8')
}

let telegramBridgeConfigMutation: Promise<void> = Promise.resolve()

export function mutateTelegramBridgeConfig<T>(mutation: () => Promise<T>): Promise<T> {
  const result = telegramBridgeConfigMutation.then(mutation)
  telegramBridgeConfigMutation = result.then(() => {}, () => {})
  return result
}
