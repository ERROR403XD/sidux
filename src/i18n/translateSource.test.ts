import { afterEach, describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { t, setUiLanguage } from '../composables/useUiLanguage'
import { zhSourceEnglish } from './zhSourceEnglish'
import { englishForSource } from './translateSource'

afterEach(() => setUiLanguage('en'))

describe('Chinese-authored interface translations', () => {
  it('translates existing and new keys in both languages without a reload', () => {
    const label = computed(() => t('附加工作目录'))
    setUiLanguage('en')
    expect(label.value).toBe('Additional working directories')
    expect(t('Save')).toBe('Save')
    setUiLanguage('zh-CN')
    expect(label.value).toBe('附加工作目录')
    expect(t('Save')).toBe('保存')
  })
  it('retains every dynamic value, including names containing Chinese or dollar signs', () => {
    setUiLanguage('en')
    expect(t('实际执行模型：中文模型$&')).toBe('Actual execution model: 中文模型$&')
    expect(t('额度读取退避中，请等待17秒')).toBe('Quota read backoff is active. Wait 17 seconds.')
    expect(t('通知失败：HTTP 503')).toBe('Notification failed: HTTP 503')
    expect(t('未知用户正文')).toBe('未知用户正文')
  })
  it('preserves literal notification placeholders and all catalog parameters', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{?\w+\}?\}/g)].map(match => match[0]).sort()
    for (const [source, english] of Object.entries(zhSourceEnglish)) {
      expect(english.trim(), source).not.toBe('')
      expect(placeholders(english), source).toEqual(placeholders(source))
      expect(englishForSource(source, {}), source).toBe(english)
    }
    expect(t('用 {{message}} 插入通知正文。')).toContain('{{message}}')
  })
  it('does not read inherited object properties as translations', () => {
    expect(t('toString')).toBe('toString')
    expect(t('constructor')).toBe('constructor')
  })
})
