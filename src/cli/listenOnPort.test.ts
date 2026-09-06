import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { listenOnPort } from './listenOnPort.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
})

describe('listenOnPort', () => {
  it('fails without incrementing when strict port is enabled', async () => {
    const occupied = createServer()
    servers.push(occupied)
    await listenOnPort(occupied, 0, true)
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('missing_test_port')
    const port = address.port

    const candidate = createServer()
    servers.push(candidate)
    await expect(listenOnPort(candidate, port, true)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(candidate.listening).toBe(false)
  })

  it('keeps legacy fallback when strict port is disabled', async () => {
    const occupied = createServer()
    servers.push(occupied)
    await listenOnPort(occupied, 0, true)
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('missing_test_port')
    const port = address.port

    const candidate = createServer()
    servers.push(candidate)
    const fallbackPort = await listenOnPort(candidate, port, false)
    expect(fallbackPort).toBeGreaterThan(port)
    expect(candidate.address()).toMatchObject({ port: fallbackPort })
  })
})
