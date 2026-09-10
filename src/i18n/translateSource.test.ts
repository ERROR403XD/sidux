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

describe('canonical Codex terminology', () => {
  it('keeps live Thinking separate from model reasoning effort', () => {
    setUiLanguage('en')
    expect(t('Thinking')).toBe('Thinking')
    setUiLanguage('zh-CN')
    expect(t('Thinking')).toBe('思考中')
    expect(t('Reasoning effort')).toBe('推理强度')
  })
  it('distinguishes user conversations from internal threads and turns', () => {
    setUiLanguage('en')
    expect(t('New chat')).toBe('New conversation')
    expect(t('Start new thread')).toBe('Start new conversation')
    expect(t('线程')).toBe('Thread')
    expect(t('缺少会话 ID')).toBe('Thread ID is missing')
    setUiLanguage('zh-CN')
    expect(t('Threads')).toBe('会话')
    expect(t('Conversations')).toBe('会话')
    expect(t('Thread')).toBe('线程')
    expect(t('Turn')).toBe('回合')
    expect(t('缺少会话 ID')).toBe('缺少线程 ID')
  })
  it('uses quota reset only for quota, preserving recovery and resume elsewhere', () => {
    setUiLanguage('en')
    expect(t('额度恢复后继续')).toBe('Resume when quota resets')
    expect(t('额度重置后继续')).toBe('Resume when quota resets')
    expect(t('恢复子任务')).toBe('Resume subtask')
    expect(t('正在恢复凭据')).toBe('Recovering credentials')
    expect(t('可用重置机会')).toBe('Available banked resets')
    setUiLanguage('zh-CN')
    expect(t('5小时额度恢复通知')).toBe('5小时额度重置通知')
    expect(t('12小时限额')).toBe('12小时额度')
    expect(t('恢复默认速度')).toBe('恢复默认速度')
    expect(t('Default reasoning effort')).toBe('默认推理强度')
    expect(t('Unlimited quota')).toBe('无限额度')
    expect(t('Unlimited credits')).toBe('无限点数')
  })
  it('normalizes catalog templates without touching captured names or protocol identifiers', () => {
    setUiLanguage('en')
    expect(t('Waiting for Codex thread/tokenUsage/updated events for this thread.')).toBe('Waiting for Codex thread/tokenUsage/updated events for this conversation.')
    expect(t('模型未公布思考强度 我的聊天恢复，请重新选择或使用模型默认。')).toBe('The model does not advertise reasoning effort 我的聊天恢复. Choose again or use the model default.')
    setUiLanguage('zh-CN')
    expect(t('模型未公布思考强度 我的聊天恢复，请重新选择或使用模型默认。')).toBe('模型未公布推理强度 我的聊天恢复，请重新选择或使用模型默认。')
    expect(t('Archive {title}. You can find it later in archived threads.', {title:'线程聊天额度恢复'})).toBe('归档“线程聊天额度恢复”。之后可在已归档会话中找到它。')
  })
})
