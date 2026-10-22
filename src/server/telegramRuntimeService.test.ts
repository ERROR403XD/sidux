import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTelegramBridgeConfig, writeTelegramBridgeConfig } from './telegramConfigStore.js'
import { initializeTelegramBridge, rememberTelegramChatId } from './telegramRuntimeService.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-telegram-runtime-'))
  vi.stubEnv('CODEX_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('Telegram runtime configuration and seen chat persistence', () => {
  it('initializes settings in order and starts only when a token exists', async () => {
    const bridge = { configureNotifications: vi.fn(), configureQuietHours: vi.fn(), configureToken: vi.fn(), configureAllowedUserIds: vi.fn(), start: vi.fn() }
    await initializeTelegramBridge(bridge)
    expect(bridge.configureNotifications).toHaveBeenCalledWith(false)
    expect(bridge.configureQuietHours).toHaveBeenCalledTimes(1)
    expect(bridge.start).not.toHaveBeenCalled()
    const config = { ...await readTelegramBridgeConfig(), botToken: 'synthetic-token', notificationsEnabled: true, allowedUserIds: [42] }
    await writeTelegramBridgeConfig(config)
    await initializeTelegramBridge(bridge)
    expect(bridge.configureToken).toHaveBeenCalledWith('synthetic-token')
    expect(bridge.configureAllowedUserIds).toHaveBeenCalledWith([42])
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(bridge.configureToken.mock.invocationCallOrder[0]).toBeLessThan(bridge.configureAllowedUserIds.mock.invocationCallOrder[0]!)
    expect(bridge.configureAllowedUserIds.mock.invocationCallOrder[0]).toBeLessThan(bridge.start.mock.invocationCallOrder[0]!)
  })

  it('serializes seen ids, keeps only fifty and leaves existing configuration fields intact', async () => {
    const config = { ...await readTelegramBridgeConfig(), botToken: 'synthetic-token', allowedUserIds: [42] }
    await writeTelegramBridgeConfig(config)
    await Promise.all(Array.from({ length: 53 }, (_, index) => rememberTelegramChatId(index + 0.9)))
    await rememberTelegramChatId(52)
    await rememberTelegramChatId(Number.NaN)
    const stored = await readTelegramBridgeConfig()
    expect(stored.chatIds).toEqual(Array.from({ length: 50 }, (_, index) => 52 - index))
    expect(stored.botToken).toBe(config.botToken)
    expect(stored.allowedUserIds).toEqual(config.allowedUserIds)
    expect(JSON.parse(await readFile(join(home, 'telegram-bridge.json'), 'utf8')).chatIds).toEqual(stored.chatIds)
  })
})
