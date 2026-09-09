import { webcrypto } from 'node:crypto'
import { expect, it } from 'vitest'
import { requestUuid } from './requestUuid'

it('creates valid distinct UUIDs on HTTP without randomUUID', () => {
  const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } as Pick<Crypto, 'getRandomValues'>
  const ids = Array.from({ length: 100 }, () => requestUuid(httpCrypto))
  expect(new Set(ids).size).toBe(100)
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
})

it('uses the native UUID API when available', () => {
  const cryptoApi = { randomUUID: () => '12345678-1234-4234-8234-123456789abc' } as unknown as Crypto
  expect(requestUuid(cryptoApi)).toBe('12345678-1234-4234-8234-123456789abc')
})
