import { describe, it, expect, vi } from 'vitest'
import { effectiveConversationChoice, useWebConversationPreferences, WEB_CONVERSATION_PREFERENCES_KEY } from './webConversationPreferences'
const a = { model: 'a', provider: 'openai', effort: 'high', tier: 'priority' }
const b = { model: 'b', provider: 'openai', effort: 'low', tier: '' }
function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
describe('WebUI conversation preferences', () => {
  it('only initializes explicitly registered WebUI threads and new composer', () => {
    const preferences = useWebConversationPreferences(storage())
    preferences.configure(a, true)
    expect(preferences.enter('', b)).toEqual(a)
    for (const id of ['automation', 'api', 'activation', 'unknown-history']) expect(preferences.enter(id, b)).toBeNull()
    preferences.register('web', b)
    expect(preferences.enter('web', a)).toEqual(b)
  })
  it('preserves separate memories across reload and ignores defaults for remembered sessions', () => {
    const saved = storage()
    const preferences = useWebConversationPreferences(saved)
    preferences.configure(a, true)
    preferences.register('web-a', a)
    preferences.register('web-b', b)
    preferences.select('web-a', { ...a, effort: 'ultra' })
    const reloaded = useWebConversationPreferences(saved)
    expect(reloaded.enter('web-a', b)?.effort).toBe('ultra')
    expect(reloaded.enter('web-b', a)).toEqual(b)
  })
  it('applies disabled memory on reentry, retains manual session changes and restores old memory when enabled', () => {
    const preferences = useWebConversationPreferences(storage())
    preferences.configure(a, true)
    preferences.register('web', b)
    preferences.configure(a, false)
    expect(preferences.sessions.value.web).toEqual(b)
    expect(preferences.enter('web', b)).toEqual(a)
    preferences.select('web', { ...b, effort: 'medium' })
    expect(preferences.sessions.value.web.effort).toBe('medium')
    expect(preferences.enter('web', b)).toEqual(a)
    preferences.configure(a, true)
    expect(preferences.enter('web', a)).toEqual(b)
  })
  it('keeps prior saved values after failed persistence', () => {
    const saved = storage()
    const preferences = useWebConversationPreferences(saved)
    preferences.configure(a, true)
    saved.setItem = vi.fn(() => { throw new Error('full') })
    expect(() => preferences.configure(b, false)).toThrow('保存失败')
    expect(preferences.state.value.defaults).toEqual(a)
    expect(saved.getItem(WEB_CONVERSATION_PREFERENCES_KEY)).toContain('priority')
  })
})

it('temporarily downgrades the model and effort without overwriting saved preference or thread memory', () => {
  const store = storage()
  const prefs = useWebConversationPreferences(store)
  const desired = { model: 'gpt-6-astra', provider: 'codex', effort: 'ultra', tier: 'priority' }
  const model = (id: string, effort: string) => ({ id, model: id, displayName: id, providerId: 'codex', isDefault: true, efforts: [{ value: 'low', description: '' }, { value: effort, description: '' }], defaultEffort: 'low', serviceTiers: [], defaultServiceTier: '', inputModalities: ['text'] })
  prefs.configure(desired, true)
  prefs.register('web', desired)
  const before = store.getItem(WEB_CONVERSATION_PREFERENCES_KEY)
  const limited = [model('gpt-5.6-terra', 'high'), model('gpt-5.6-luna', 'medium')]
  expect(effectiveConversationChoice(prefs.enter('web', desired)!, limited)).toMatchObject({ model: 'gpt-5.6-terra', effort: 'high', tier: '' })
  expect(store.getItem(WEB_CONVERSATION_PREFERENCES_KEY)).toBe(before)
  const full = [{ ...model('gpt-6-astra', 'ultra'), serviceTiers: [{ value: 'priority', label: 'Fast', description: '' }] }]
  const reloaded = useWebConversationPreferences(store)
  expect(effectiveConversationChoice(reloaded.enter('web', desired)!, full)).toEqual(desired)
  expect(reloaded.state.value.defaults).toEqual(desired)
})
