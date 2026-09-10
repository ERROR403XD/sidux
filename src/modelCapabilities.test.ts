import { describe, it, expect } from 'vitest'
import { normalizeModelCapability, effortOptions, tierOptions, modelSettingsProblem, capabilityValue } from './modelCapabilities'
import { normalizeStoredQueuedMessage } from './threadQueue'
import { normalizeAutomationModelSettings } from './automationOptions'
import { parseAutomationToml, serializeAutomationToml } from './server/automationDefinition'
import { normalizeThreadMessagesV2 } from './api/normalizers/v2'
import { normalizeToolSummary } from './api/normalizers/toolSummary'

const model = normalizeModelCapability({ id: 'future-model', defaultReasoningEffort: 'max', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority', name: 'Fast', description: 'directory description' }], inputModalities: ['text'] })!
describe('model capabilities across saved settings and requests', () => {
  it('uses advertised values and preserves unknown saved values without claiming support', () => {
    expect(effortOptions(model).map(row => row.value)).toEqual(['', 'max', 'ultra'])
    expect(effortOptions(model, 'future-effort').at(-1)?.label).toContain('目录未确认')
    expect(modelSettingsProblem(model, 'future-effort', '')).toContain('重新选择')
    expect(tierOptions(model).map(row => row.value)).toEqual(['', 'priority'])
    expect(modelSettingsProblem(model, 'max', 'priority')).toBe('')
  })
  it('distinguishes missing from explicitly empty capabilities and respects modalities', () => {
    const unknown = normalizeModelCapability('future-model', 'custom')!
    expect(unknown.efforts).toBeNull()
    expect(modelSettingsProblem(unknown, 'future-effort', 'custom-tier', true)).toBe('')
    expect(effortOptions(unknown).map(row => row.value)).toEqual([''])
    expect(modelSettingsProblem(model, 'max', 'priority', true)).toContain('不支持图片')
    expect(modelSettingsProblem(normalizeModelCapability({ id: 'x', supportedReasoningEfforts: [] }), 'low', '')).toContain('未公布')
  })
  it('keeps strings open-ended while rejecting empty and malformed values', () => {
    expect(capabilityValue('ultra')).toBe('ultra')
    expect(normalizeAutomationModelSettings({ reasoningEffort: 'future-valid' }).reasoningEffort).toBe('future-valid')
    for (const value of ['\nmedium', 5, {}, 'x'.repeat(129)]) expect(() => normalizeAutomationModelSettings({ reasoningEffort: value })).toThrow()
  })
  it('roundtrips new effort and service tiers in automation TOML without dropping custom keys', () => {
    const record = parseAutomationToml("id='fixture'\nname='fixture'\nprompt='fixture'\nrrule='FREQ=DAILY'\ncwds=['/test-workspace']\nmodel='future-model'\nmodel_reasoning_effort='ultra'\nservice_tier='priority'\ncreated_at=1\nupdated_at=2\ncustom=42")!
    expect(record).toMatchObject({ model: 'future-model', reasoningEffort: 'ultra', serviceTier: 'priority' })
    expect(parseAutomationToml(serializeAutomationToml(record))).toMatchObject(record)
  })
  it('retains queue-time model settings and explicit null default across persistence', () => {
    const row = { id: 'q', text: 'fixture', model: 'future-model', effort: 'ultra', serviceTier: null }
    expect(normalizeStoredQueuedMessage(JSON.parse(JSON.stringify(row)))).toMatchObject(row)
    expect(normalizeStoredQueuedMessage({ id: 'legacy', text: 'legacy' })).not.toHaveProperty('serviceTier')
  })
  it('uses the same bounded summary for live and historical unhandled items', () => {
    for (const type of ['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'futureEvent']) {
      const item = { id: 'tool', type, status: 'completed', arguments: { secret: 'never-copy' }, result: 'x'.repeat(10000) }
      const live = normalizeToolSummary(item)!
      const history = normalizeThreadMessagesV2({ thread: { turns: [{ id: 'turn', items: [item] }] } } as never)
      expect(history[0]).toMatchObject(live)
      expect(JSON.stringify(live)).not.toContain('never-copy')
      expect(JSON.stringify(live).length).toBeLessThan(800)
    }
    expect(normalizeToolSummary({ id: 'reasoning', type: 'reasoning' })).toBeNull()
  })
})

describe('fast mode controls shared by composer and automations', () => {
  it('disables missing external capabilities while preserving advertised raw effort values', async () => {
    const { fastModeControl, reasoningUnavailable } = await import('./modelCapabilities')
    const unknown = normalizeModelCapability('sample', 'custom')!
    expect(reasoningUnavailable(unknown)).toBe(true)
    expect(effortOptions(unknown, 'high')).toEqual([{ value: '', label: 'N/A' }])
    expect(fastModeControl(unknown, 'priority')).toMatchObject({ checked: false, disabled: true })
    const supported = { ...model, providerId: 'custom' }
    expect(reasoningUnavailable(supported)).toBe(false)
    expect(effortOptions(supported)[1].label).toBe('max')
    expect(fastModeControl(supported).disabled).toBe(false)
  })
  it('only enables advertised fast tiers and can clear unsupported saved tiers', async () => {
    const { fastModeControl } = await import('./modelCapabilities')
    expect(fastModeControl(model, '')).toMatchObject({ checked: false, disabled: false, nextValue: 'priority' })
    expect(fastModeControl(model, 'priority')).toMatchObject({ checked: true, nextValue: '' })
    expect(fastModeControl(undefined)).toMatchObject({ checked: false, disabled: true })
    expect(fastModeControl(undefined, 'legacy')).toMatchObject({ disabled: false, nextValue: '' })
    const defaultFast = { ...model, defaultServiceTier: 'priority' }
    expect(fastModeControl(defaultFast)).toMatchObject({ checked: true, disabled: true })
    expect(fastModeControl({ ...defaultFast, serviceTiers: [...model.serviceTiers!, { value: 'standard', label: 'Standard', description: '' }] })).toMatchObject({ checked: true, disabled: false, nextValue: 'standard' })
  })
})
