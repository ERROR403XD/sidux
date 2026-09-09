import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyComponent, type ComponentGeneration } from './component.js'
import type { AccountAuthCoordinator } from '../accountAuthCoordinator.js'

afterEach(() => vi.useRealTimers())
describe('gateway owned recovery', () => {
  it('keeps 400 request-scoped and recovers after bounded 500 backoff without replay', async () => {
    vi.useFakeTimers()
    const coordinator = { blocksApiAccount: () => false, isAccountOperationInProgress: () => false } as unknown as AccountAuthCoordinator
    const component = new ProxyComponent('/unused', coordinator)
    const generation = { process: { exitCode: null, signalCode: null }, expiresAt: new Date(Date.now() + 3600_000).toISOString() } as ComponentGeneration
    Object.assign(component, { current: generation, checkedAt: Date.now() })
    component.recordResult(generation, 400)
    expect(await component.prepare(null)).toBe(generation)
    component.recordResult(generation, 500)
    expect(component.status().ready).toBe(false)
    await expect(component.prepare(null)).rejects.toMatchObject({ code: 'component_backoff' })
    vi.advanceTimersByTime(1001)
    expect(await component.prepare(null)).toBe(generation)
    component.recordResult(generation, 200)
    expect(component.status()).toMatchObject({ ready: true, lastError: null, retryAt: null })
  })
  it('honors retry-after and ignores old-generation errors', () => {
    vi.useFakeTimers()
    const component = new ProxyComponent('/unused', {} as unknown as AccountAuthCoordinator)
    const generation = { process: { exitCode: null, signalCode: null } } as ComponentGeneration
    Object.assign(component, { current: generation })
    component.recordResult(generation, 429, '60')
    expect(Date.parse(component.status().retryAt!) - Date.now()).toBe(60_000)
    component.recordResult({} as ComponentGeneration, 500)
    expect(Date.parse(component.status().retryAt!) - Date.now()).toBe(60_000)
    component.recordResult(generation, 200)
    expect(component.status().ready).toBe(false)
  })
})

it('reclaims an unused current generation while retaining a pinned old connection on another rotation', async () => {
  const coordinator = { blocksApiAccount: () => false, getApiCredential: async () => ({ storageId: 'a', revision: 3 }) } as unknown as AccountAuthCoordinator
  const component = new ProxyComponent('/unused', coordinator)
  const pinned = { id: 'pinned', references: 1 } as ComponentGeneration
  const current = { id: 'current', storageId: 'a', revision: 2, references: 0, process: { exitCode: null, signalCode: null } } as ComponentGeneration
  const generations = new Set([pinned, current])
  Object.assign(component, { current, generations, binary: '/missing-fixture-proxy-binary' })
  const stop = vi.spyOn(component as any, 'stopGeneration').mockImplementation(async (row: any) => { generations.delete(row) })
  await expect(component.prepare('a')).rejects.toMatchObject({ code: 'component_missing' })
  expect(stop).toHaveBeenCalledExactlyOnceWith(current)
  expect(generations.has(pinned)).toBe(true)
})
it('does not reclaim either pinned generation when both still serve connections', async () => {
  const coordinator = { blocksApiAccount: () => false, getApiCredential: async () => ({ storageId: 'a', revision: 3 }) } as unknown as AccountAuthCoordinator
  const component = new ProxyComponent('/unused', coordinator)
  const pinned = { references: 1 } as ComponentGeneration
  const current = { storageId: 'a', revision: 2, references: 1, process: { exitCode: null, signalCode: null } } as ComponentGeneration
  Object.assign(component, { current, generations: new Set([pinned, current]) })
  const stop = vi.spyOn(component as any, 'stopGeneration')
  await expect(component.prepare('a')).rejects.toMatchObject({ code: 'credential_drain_required' })
  expect(stop).not.toHaveBeenCalled()
})
