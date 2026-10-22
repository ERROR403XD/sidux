import { mutateTelegramBridgeConfig, readTelegramBridgeConfig, writeTelegramBridgeConfig } from './telegramConfigStore.js'
import type { TelegramThreadBridge } from './telegramThreadBridge.js'

export function rememberTelegramChatId(chatId: number): Promise<void> {
  const normalizedChatId = Math.trunc(chatId)
  if (!Number.isFinite(normalizedChatId)) return Promise.resolve()

  return mutateTelegramBridgeConfig(async () => {
    const current = await readTelegramBridgeConfig()
    if (current.chatIds.includes(normalizedChatId)) return
    const next = {
      ...current,
      chatIds: [normalizedChatId, ...current.chatIds].slice(0, 50),
    }
    await writeTelegramBridgeConfig(next)
  })
}

export function initializeTelegramBridge(
  bridge: Pick<TelegramThreadBridge, 'configureNotifications' | 'configureQuietHours' | 'configureToken' | 'configureAllowedUserIds' | 'start'>,
): Promise<void> {
  return mutateTelegramBridgeConfig(async () => {
    const config = await readTelegramBridgeConfig()
    bridge.configureNotifications(config.notificationsEnabled)
    bridge.configureQuietHours(config)
    if (!config.botToken) return
    bridge.configureToken(config.botToken)
    bridge.configureAllowedUserIds(config.allowedUserIds)
    bridge.start()
  })
}
