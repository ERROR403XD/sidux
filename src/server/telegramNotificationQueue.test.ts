import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TelegramNotificationQueue } from './telegramNotificationQueue'
import { inQuietHours, defaultQuietHours } from '../accountNotifications'

it('defers overnight, survives restart, drains once and never sends queued messages with another bot token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-quiet-'))
  let now = Date.parse('2026-09-10T15:00:00Z')
  let botId = 'bot-a'
  let enabled = true
  const settings = { ...defaultQuietHours, quietEnabled: true }
  const send = vi.fn(async (_chat: number, _text: string) => {})
  const options = { directory, settings: () => settings, enabled: () => enabled, botId: () => botId, send, now: () => now }
  let queue = new TelegramNotificationQueue(options)
  try {
    await queue.enqueue([123, 456], 'night reply')
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8'))).toHaveLength(2)
    queue.stop()
    queue = new TelegramNotificationQueue(options)
    now = Date.parse('2026-09-11T00:00:00Z')
    await queue.flush()
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    now = Date.parse('2026-09-11T15:00:00Z')
    await queue.enqueue([123], 'old bot')
    botId = 'bot-b'
    now = Date.parse('2026-09-12T00:00:00Z')
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    now = Date.parse('2026-09-12T15:00:00Z')
    await queue.enqueue([123], 'disabled')
    enabled = false
    await queue.clear()
    enabled = true
    now = Date.parse('2026-09-13T00:00:00Z')
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRejectedValueOnce(new Error('lost response'))
    await queue.enqueue([123], 'uncertain')
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(3)
  } finally {
    queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses the saved timezone and treats equal boundaries as all day', () => {
  const now = Date.parse('2026-09-10T15:00:00Z')
  expect(inQuietHours({ ...defaultQuietHours, quietEnabled: true }, now)).toBe(true)
  expect(inQuietHours({ ...defaultQuietHours, quietEnabled: true, timezone: 'UTC' }, now)).toBe(false)
  expect(inQuietHours({ ...defaultQuietHours, quietEnabled: true, quietStart: '08:00' }, now)).toBe(true)
})

it('reschedules pending notifications when the same bridge resumes during quiet hours', async () => {
  vi.useFakeTimers()
  let now = Date.parse('2026-09-10T15:00:00Z')
  const send = vi.fn(async () => {})
  const queue = new TelegramNotificationQueue({
    settings: () => ({ ...defaultQuietHours, quietEnabled: true }),
    enabled: () => true,
    botId: () => 'fixture-bot',
    send,
    now: () => now,
  })
  try {
    await queue.enqueue([123], 'night reply')
    queue.stop()
    queue.start()
    await queue.settled()
    now = Date.parse('2026-09-11T00:00:00Z')
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledExactlyOnceWith(123, 'night reply')
  } finally {
    queue.stop()
    vi.useRealTimers()
  }
})
