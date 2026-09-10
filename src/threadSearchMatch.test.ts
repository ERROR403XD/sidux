import { describe, expect, it } from 'vitest'
import { createThreadMatcher } from './threadSearchMatch'

describe('thread title matching', () => {
  it('normalizes full-width text, case and repeated whitespace', () => {
    expect(createThreadMatcher('  ＡＰＩ　 KEY ' )('api key')).toBe(4)
  })
  it('requires all words instead of any word and treats punctuation literally', () => {
    const match = createThreadMatcher('API key')
    expect(match('API export')).toBe(0)
    expect(match('key rotation')).toBe(0)
    expect(match('key for API')).toBe(1)
    expect(createThreadMatcher('[test]')('a [test] title')).toBe(2)
    expect(createThreadMatcher('[test]')('test')).toBe(0)
    expect(createThreadMatcher('   ')('anything')).toBe(0)
  })
})
