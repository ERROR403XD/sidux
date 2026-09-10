import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramThreadBridge } from './telegramThreadBridge'

const reply = { thread: { turns: [{ items: [{ type: 'agentMessage', text: 'Fixture reply' }] }] } }
const completed = (id: string) => ({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id } } })

function setup() {
  const rpc = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => reply)
  const bridge = new TelegramThreadBridge({ rpc, onNotification: () => () => {} })
  // Exercise the notification handler without starting Telegram polling or a real Codex process.
  const internal = bridge as unknown as {
    chatIdsByThreadId: Map<string, Set<number>>
    handleNotification: (notification: ReturnType<typeof completed>) => Promise<void>
    sendOnlineMessage: (chatId: number) => Promise<void>
    handleIncomingUpdate: (update: unknown) => Promise<void>
  }
  internal.chatIdsByThreadId.set('fixture-thread', new Set([123, 456]))
  bridge.configureAllowedUserIds([123])
  const network = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })))
  vi.stubGlobal('fetch', network)
  return { bridge, internal, rpc, network }
}

afterEach(() => vi.unstubAllGlobals())

describe('Telegram notification switch', () => {
  it('skips history reads and all automatic sends while disabled, then resumes without losing bindings', async () => {
    const { bridge, internal, rpc, network } = setup()
    bridge.configureNotifications(false)
    await internal.handleNotification(completed('off'))
    await internal.sendOnlineMessage(123)
    await expect(bridge.sendTestNotification([123], 'Test')).rejects.toThrow('disabled')
    expect(rpc).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(internal.chatIdsByThreadId.get('fixture-thread')).toEqual(new Set([123, 456]))
    bridge.configureNotifications(true)
    await internal.handleNotification(completed('on'))
    await internal.handleNotification(completed('on'))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('cancels unsent notifications if disabled while history is loading', async () => {
    const { bridge, internal, rpc, network } = setup()
    let finish!: (value: unknown) => void
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = internal.handleNotification(completed('loading'))
    bridge.configureNotifications(false)
    finish(reply)
    await pending
    expect(network).not.toHaveBeenCalled()
  })

  it('stops remaining chunks and recipients if disabled during a send', async () => {
    const { bridge, network } = setup()
    network.mockImplementationOnce(async () => {
      bridge.configureNotifications(false)
      return new Response(JSON.stringify({ ok: false }), { status: 400 })
    })
    await bridge.sendTestNotification([123, 456], 'x'.repeat(8000))
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('continues answering explicit bot commands when automatic notifications are disabled', async () => {
    const { bridge, internal, network } = setup()
    bridge.configureNotifications(false)
    await internal.handleIncomingUpdate({ message: { text: '/whoami', from: { id: 123 }, chat: { id: 123 } } })
    expect(network).toHaveBeenCalledTimes(1)
    expect(bridge.getStatus().allowedUsers).toBe(1)
  })
})
