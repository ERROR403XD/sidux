import { describe, expect, it } from 'vitest'
import { apiProxyModelMenuState, apiProxyModelNames, apiProxyModelSuggestions } from './apiProxyModels'

describe('api proxy model catalogs', () => {
  it('reads model names from both management catalog shapes', () => {
    expect(apiProxyModelNames({ data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra' }] })).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra'])
    expect(apiProxyModelNames([{ id: 'custom-a', displayName: 'A' }, { model: 'custom-b' }])).toEqual(['custom-a', 'custom-b'])
    expect(apiProxyModelNames(['  spaced  ', 'spaced'])).toEqual(['spaced'])
    expect(apiProxyModelNames({ data: 'invalid' })).toEqual([])
    expect(apiProxyModelNames(null)).toEqual([])
  })
  it('keeps only the typed match and drops an exact hit from its own suggestion list', () => {
    const models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'claude-sonnet-4']
    expect(apiProxyModelSuggestions(models, '')).toEqual(models)
    expect(apiProxyModelSuggestions(models, 'GPT-5.6')).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra'])
    expect(apiProxyModelSuggestions(models, ' gpt-5.6-luna ')).toEqual([])
    expect(apiProxyModelSuggestions(models, 'missing')).toEqual([])
  })
  it('caps the suggestion list without reordering the catalog', () => {
    const models = Array.from({ length: 90 }, (_, index) => `model-${index}`)
    expect(apiProxyModelSuggestions(models, 'model-').at(0)).toBe('model-0')
    expect(apiProxyModelSuggestions(models, 'model-')).toHaveLength(60)
  })
  it('stays closed when no account was resolved, so the field is manual-only', () => {
    expect(apiProxyModelMenuState([], '', 'idle')).toEqual({ suggestions: [], emptyMessage: '', visible: false })
  })
  it('lists candidates once the account catalog is ready', () => {
    const menu = apiProxyModelMenuState(['gpt-5.6-luna', 'gpt-5.6-terra'], 'luna', 'ready')
    expect(menu.suggestions).toEqual(['gpt-5.6-luna'])
    expect(menu.visible).toBe(true)
  })
  it('explains an empty catalog, a pending read, and a failed read instead of staying blank', () => {
    expect(apiProxyModelMenuState(['a'], 'zzz', 'ready')).toEqual({ suggestions: [], emptyMessage: '目录中没有匹配的模型，可自行输入。', visible: true })
    expect(apiProxyModelMenuState([], '', 'loading')).toEqual({ suggestions: [], emptyMessage: '正在读取模型目录…', visible: true })
    expect(apiProxyModelMenuState([], '', 'failed').emptyMessage).toBe('无法读取该账号的模型目录，可自行输入。')
  })
})
