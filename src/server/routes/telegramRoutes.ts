import type { IncomingMessage, ServerResponse } from 'node:http'
import { validateQuietHours } from '../../accountNotifications.js'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import {
  mutateTelegramBridgeConfig,
  normalizeTelegramBridgeConfig,
  readTelegramBridgeConfig,
  writeTelegramBridgeConfig,
  type TelegramBridgeConfigState,
} from '../telegramConfigStore.js'
import type { TelegramThreadBridge } from '../telegramThreadBridge.js'

type TelegramRouteDependencies = {
  telegramBridge: Pick<TelegramThreadBridge,
    | 'configureNotifications'
    | 'configureQuietHours'
    | 'configureToken'
    | 'configureAllowedUserIds'
    | 'start'
    | 'sendTestNotification'
    | 'getStatus'
  >
}

export function createTelegramRoutes(
  dependencies: TelegramRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { telegramBridge } = dependencies

  async function configureBot(req: IncomingMessage, res: ServerResponse, context: RouteRequestContext): Promise<void> {
    const payload = asRecord(await context.readJsonBody(req))
    const botToken = typeof payload?.botToken === 'string' ? payload.botToken.trim() : ''
    const rawAllowedUserIds = Array.isArray(payload?.allowedUserIds) ? payload.allowedUserIds : []
    if (!botToken) {
      setJson(res, 400, { error: 'Missing botToken' })
      return
    }
    const config = normalizeTelegramBridgeConfig({
      botToken,
      allowedUserIds: rawAllowedUserIds,
      notificationsEnabled: payload?.notificationsEnabled,
      quietEnabled: payload?.quietEnabled,
      quietStart: payload?.quietStart,
      quietEnd: payload?.quietEnd,
      timezone: payload?.timezone,
    })
    if (config.allowedUserIds.length === 0) {
      setJson(res, 400, { error: 'At least one allowed Telegram user ID is required' })
      return
    }

    await mutateTelegramBridgeConfig(async () => {
      const existingConfig = await readTelegramBridgeConfig()
      if (typeof payload?.notificationsEnabled !== 'boolean' && existingConfig.botToken) {
        config.notificationsEnabled = existingConfig.notificationsEnabled
      }
      for (const key of ['quietEnabled', 'quietStart', 'quietEnd', 'timezone'] as const) {
        if (payload?.[key] === undefined) Object.assign(config, { [key]: existingConfig[key] })
      }
      await writeTelegramBridgeConfig({ ...config, chatIds: existingConfig.chatIds })
      telegramBridge.configureNotifications(config.notificationsEnabled)
      telegramBridge.configureQuietHours(config)
      telegramBridge.configureToken(config.botToken)
      telegramBridge.configureAllowedUserIds(config.allowedUserIds)
      telegramBridge.start()
    })
    setJson(res, 200, { ok: true })
  }

  async function updateNotificationPreferences(req: IncomingMessage, res: ServerResponse, context: RouteRequestContext): Promise<void> {
    const payload = asRecord(await context.readJsonBody(req)) ?? {}
    try {
      await mutateTelegramBridgeConfig(async () => {
        const current = await readTelegramBridgeConfig()
        const settings = validateQuietHours({
          timezone: payload.timezone === undefined ? current.timezone : payload.timezone as string,
          quietEnabled: payload.quietEnabled === undefined ? current.quietEnabled : payload.quietEnabled as boolean,
          quietStart: payload.quietStart === undefined ? current.quietStart : payload.quietStart as string,
          quietEnd: payload.quietEnd === undefined ? current.quietEnd : payload.quietEnd as string,
        })
        await writeTelegramBridgeConfig({ ...current, ...settings })
        telegramBridge.configureQuietHours(settings)
      })
      setJson(res, 200, { ok: true })
    } catch (error) {
      setJson(res, 400, { error: error instanceof Error ? error.message : '保存失败' })
    }
  }

  async function sendTestNotification(req: IncomingMessage, res: ServerResponse, context: RouteRequestContext): Promise<void> {
    const config = await readTelegramBridgeConfig()
    const payload = asRecord(await context.readJsonBody(req))
    if (!config.notificationsEnabled) {
      setJson(res, 400, { error: payload?.language === 'zh-CN' ? 'Telegram通知已关闭。' : 'Telegram notifications are disabled.' })
      return
    }
    const allowAll = config.allowedUserIds.includes('*')
    const chatIds = [
      ...new Set([
        ...config.chatIds.filter(id => allowAll || config.allowedUserIds.includes(id)),
        ...config.allowedUserIds.filter((id): id is number => typeof id === 'number'),
      ]),
    ].slice(0, 50)
    if (!config.botToken || !chatIds.length) {
      setJson(res, 400, { error: '请先保存Telegram设置，并与机器人开始会话。' })
      return
    }
    try {
      await telegramBridge.sendTestNotification(chatIds, payload?.language === 'zh-CN' ? 'Sidux 测试通知' : 'Sidux test notification')
      setJson(res, 200, { ok: true })
    } catch {
      setJson(res, 502, { error: '测试通知发送失败。' })
    }
  }

  async function readConfig(res: ServerResponse): Promise<void> {
    const config: TelegramBridgeConfigState = await readTelegramBridgeConfig()
    setJson(res, 200, {
      data: {
        botToken: config.botToken,
        notificationsEnabled: config.notificationsEnabled,
        quietEnabled: config.quietEnabled,
        quietStart: config.quietStart,
        quietEnd: config.quietEnd,
        timezone: config.timezone,
        allowedUserIds: config.allowedUserIds,
      },
    })
  }

  return async (req, res, url, context) => {
    if (url.pathname === '/codex-api/telegram/configure-bot' && req.method === 'POST') {
      await configureBot(req, res, context)
      return true
    }
    if (url.pathname === '/codex-api/telegram/notification-preferences' && req.method === 'POST') {
      await updateNotificationPreferences(req, res, context)
      return true
    }
    if (url.pathname === '/codex-api/telegram/test' && req.method === 'POST') {
      await sendTestNotification(req, res, context)
      return true
    }
    if (url.pathname === '/codex-api/telegram/config' && req.method === 'GET') {
      await readConfig(res)
      return true
    }
    if (url.pathname === '/codex-api/telegram/status' && req.method === 'GET') {
      setJson(res, 200, { data: telegramBridge.getStatus() })
      return true
    }
    return false
  }
}
