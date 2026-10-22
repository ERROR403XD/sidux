import { describe, expect, it } from 'vitest'
import { isApiProxyKeyInvalid, visibleApiProxyKeys } from './apiProxy.js'

const now = Date.parse('2026-09-14T12:00:00.000Z')
function key(patch: Partial<{ id: string; enabled: boolean; expiresAt: string | null; revokedAt: string | null }>) {
  return { id: 'k1', name: 'Codex CLI', suffix: 'abcd', enabled: true, expiresAt: null, revokedAt: null, lastUsedAt: null, ...patch }
}

describe('API key validity classification', () => {
  it('keeps a manually disabled key in the enabled list', () => {
    const disabled = key({ enabled: false })
    expect(isApiProxyKeyInvalid(disabled, now)).toBe(false)
    expect(visibleApiProxyKeys([disabled], false, now)).toEqual([disabled])
    expect(visibleApiProxyKeys([disabled], true, now)).toEqual([])
  })
  it('treats revoked and expired keys as invalid', () => {
    const revoked = key({ id: 'k2', revokedAt: '2026-09-13T00:00:00.000Z' })
    const expired = key({ id: 'k3', expiresAt: '2026-09-14T11:59:59.000Z' })
    const future = key({ id: 'k4', expiresAt: '2026-09-14T12:00:01.000Z' })
    expect(visibleApiProxyKeys([revoked, expired], true, now)).toEqual([revoked, expired])
    expect(visibleApiProxyKeys([revoked, expired, future], false, now)).toEqual([future])
  })
  it('treats a disabled key that later expires as invalid', () => {
    expect(isApiProxyKeyInvalid(key({ enabled: false, expiresAt: '2026-09-14T11:00:00.000Z' }), now)).toBe(true)
  })
  it('keeps a key with an unparsable expiry in the enabled list instead of hiding it', () => {
    expect(isApiProxyKeyInvalid(key({ expiresAt: 'not-a-date' }), now)).toBe(false)
  })
})
