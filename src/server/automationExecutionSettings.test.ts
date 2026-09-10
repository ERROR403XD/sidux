import { describe, expect, it, vi } from 'vitest'
import { automationTimeContext, formatAutomationTime } from './automationTime'
import { parseAutomationToml, serializeAutomationToml } from './automationDefinition'
import { normalizeAutomationModelSettings } from '../automationOptions'
import { createAutomationRuntime } from './automationRuntime'

describe('automation execution settings and local reference time', () => {
  it('roundtrips fixed/global accounts and protection without a key-owned percentage', () => {
    const raw = `id='test'\nname='fixture'\nprompt='fixture'\nrrule='FREQ=DAILY'\ncwds=['/tmp']\naccount_storage_id='${'a'.repeat(64)}'\nprotected=true`
    const parsed = parseAutomationToml(raw)!
    expect(parsed).toMatchObject({ accountStorageId: 'a'.repeat(64), protected: true })
    expect(parseAutomationToml(serializeAutomationToml(parsed))).toMatchObject({ accountStorageId: 'a'.repeat(64), protected: true })
    expect(normalizeAutomationModelSettings({ accountStorageId: null }, parsed)).toMatchObject({ accountStorageId: null, protected: true })
    expect(() => normalizeAutomationModelSettings({ protected: 'yes' })).toThrow('保护')
  })
  it('roundtrips model, effort and timezone while retaining unknown fields and allowing explicit default reset', () => {
    const raw = `id='test'\nname='fixture'\nprompt='fixture'\nrrule='FREQ=DAILY'\ncwds=['/tmp']\nmodel='chosen-model'\nmodel_reasoning_effort='high'\ntimezone='Asia/Shanghai'\ncreated_at=1\nupdated_at=2\ncustom=42`
    const parsed = parseAutomationToml(raw)!
    expect(parsed).toMatchObject({ model: 'chosen-model', reasoningEffort: 'high', timezone: 'Asia/Shanghai' })
    expect(parseAutomationToml(serializeAutomationToml(parsed))).toEqual(parsed)
    expect(normalizeAutomationModelSettings({}, parsed)).toEqual({ model: 'chosen-model', reasoningEffort: 'high' })
    expect(normalizeAutomationModelSettings({ model: null, reasoningEffort: '' }, parsed)).toEqual({ model: undefined, reasoningEffort: undefined })
    expect(() => normalizeAutomationModelSettings({ reasoningEffort: '\ninvalid' })).toThrow('思考强度')
  })
  it('expresses date rollover and DST offsets without labelling UTC as local time', () => {
    const at = Date.parse('2026-09-06T17:00:00Z')
    expect(formatAutomationTime(at, 'Asia/Shanghai')).toBe('2026-09-07 01:00:00 +08:00（Asia/Shanghai）')
    expect(formatAutomationTime(Date.parse('2026-07-01T12:00:00Z'), 'America/New_York')).toContain('08:00:00 -04:00')
    expect(formatAutomationTime(Date.parse('2026-12-01T12:00:00Z'), 'America/New_York')).toContain('07:00:00 -05:00')
    expect(automationTimeContext({ trigger: 'manual', scheduledAt: at, startedAt: at + 60000, timezone: 'Asia/Shanghai' })).toContain('手动请求时间：2026-09-07 01:00:00 +08:00')
    expect(automationTimeContext({ trigger: 'schedule', scheduledAt: at, startedAt: at + 60000, timezone: 'Asia/Shanghai' })).toContain('实际开始时间：2026-09-07 01:01:00 +08:00')
  })
  it('applies explicit model/effort to new and reused threads and retains defaults when unspecified', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start' ? { thread: { id: 'new-thread' }, model: 'chosen-model' } : {})
    const runtime = createAutomationRuntime({ rpc, accountBusy: () => false, hasQueuedMessages: async () => false, pendingRequests: () => [], readHistory: async () => ({}), buildParams: async () => ({ collaborationMode: { mode: 'default', settings: { model: 'default-model', reasoning_effort: 'medium', developer_instructions: null } } }) })
    await runtime.createThread('/tmp', 'fixture', { model: 'chosen-model' })
    expect(rpc).toHaveBeenCalledWith('thread/start', { cwd: '/tmp', model: 'chosen-model' }, undefined)
    const params = await runtime.prepare('existing-thread', 'fixture', 'run', { model: 'chosen-model', reasoningEffort: 'high' })
    expect(rpc.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
    expect(rpc.mock.calls.some(([method]) => method === 'thread/read')).toBe(false)
    expect(params).toMatchObject({ model: 'chosen-model', effort: 'high', collaborationMode: { settings: { model: 'chosen-model', reasoning_effort: 'high' } } })
    expect(await runtime.prepare('existing-thread', 'fixture', 'run')).toMatchObject({ collaborationMode: { settings: { model: 'default-model', reasoning_effort: 'medium' } } })
  })
})


describe('automation model defaults', () => {
  it('clears inherited effort and speed when selecting another model without overrides', async () => {
    const runtime = createAutomationRuntime({ rpc: async () => ({}), accountBusy: () => false, hasQueuedMessages: async () => false, pendingRequests: () => [], readHistory: async () => ({}), buildParams: async () => ({ effort: 'ultra', serviceTier: 'priority', collaborationMode: { mode: 'default', settings: { model: 'old', reasoning_effort: 'ultra' } } }) })
    const params = await runtime.prepare('fixture', 'fixture', 'run', { model: 'other' })
    expect(params).not.toHaveProperty('effort')
    expect(params).toMatchObject({ model: 'other', serviceTier: null, collaborationMode: { settings: { model: 'other', reasoning_effort: null } } })
  })
})
