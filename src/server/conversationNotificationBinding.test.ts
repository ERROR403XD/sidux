import { expect, it, vi } from 'vitest'
import { bindConversationNotifications } from './conversationNotificationBinding'
import type { AccountNotificationService } from './accountNotificationService'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

it('ignores streaming deltas and unsubscribes before waiting for pending delivery work', async () => {
  let listener: (notification: { method: string; params: unknown }) => void = () => {}
  let release!: () => void
  const unsubscribe = vi.fn()
  const readConversationNotificationContext = vi.fn(async () => ({ title: '标题', projectName: '项目' }))
  const source = {
    subscribeNotifications: vi.fn(callback => { listener = callback; return unsubscribe }),
    readConversationNotificationContext,
  }
  const observeConversation = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const dispose = bindConversationNotifications(source, { observeConversation } as unknown as AccountNotificationService)
  for (let index = 0; index < 1000; index++) listener({ method: 'item/agentMessage/delta', params: {} })
  expect(observeConversation).not.toHaveBeenCalled()
  const terminal = { method: 'turn/completed', params: { threadId: 'thread' } }
  listener(terminal)
  expect(observeConversation).toHaveBeenCalledExactlyOnceWith(terminal, readConversationNotificationContext)
  let settled = false
  const stopping = dispose().then(() => { settled = true })
  expect(unsubscribe).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await stopping
  expect(settled).toBe(true)
})

it('forwards native GOAL changes before subsequent completions', async () => {
  let listener: (notification: { method: string; params: unknown }) => void = () => {}
  const observeConversation = vi.fn(async (_notification: { method: string; params: unknown }) => {})
  const dispose = bindConversationNotifications({
    subscribeNotifications: callback => { listener = callback; return () => {} },
    readConversationNotificationContext: async () => ({ title: '', projectName: '' }),
  }, { observeConversation } as unknown as AccountNotificationService)
  for (const method of ['thread/goal/updated', automaticResumeStartedMethod, 'turn/completed', 'thread/goal/cleared', 'turn/completed']) listener({ method, params: { threadId: 'goal' } })
  await dispose()
  expect(observeConversation.mock.calls.map(row => row[0].method)).toEqual(['thread/goal/updated', automaticResumeStartedMethod, 'turn/completed', 'thread/goal/cleared', 'turn/completed'])
})
