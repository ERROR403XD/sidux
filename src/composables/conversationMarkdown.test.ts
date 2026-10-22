import { describe, expect, it } from 'vitest'
import { createConversationInlineParser, headingClass, headingTag, parseMessageBlocks, toBrowseUrl } from './conversationMarkdown'

describe('Conversation Markdown parsing contracts', () => {
  it('preserves headings, tasks and ordered list starts with CRLF input', () => {
    expect(parseMessageBlocks('# Title\r\n\r\n- [x] Done\r\n- [ ] Next\r\n\r\n3. First\r\n4. Second')).toEqual([
      { kind: 'heading', level: 1, value: 'Title' },
      { kind: 'taskList', items: [{ text: 'Done', checked: true }, { text: 'Next', checked: false }] },
      { kind: 'orderedList', start: 3, items: [{ paragraphs: ['First'] }, { paragraphs: ['Second'] }] },
    ])
  })

  it('keeps fenced image and link text as code while parsing images outside the fence', () => {
    expect(parseMessageBlocks('```js\n![code](https://example.test/code.png)\n```\n\n![image](/workspace/image.png)')).toEqual([
      { kind: 'codeBlock', language: 'js', value: '![code](https://example.test/code.png)' },
      { kind: 'image', alt: 'image', url: '/codex-local-image?path=%2Fworkspace%2Fimage.png', markdown: '![image](/workspace/image.png)' },
    ])
  })

  it('preserves table alignment and escaped pipes without splitting cells', () => {
    expect(parseMessageBlocks('| A | B |\n| :--- | ---: |\n| one \\| two | three |')).toEqual([
      { kind: 'table', headers: ['A','B'], alignments: ['left','right'], rows: [['one | two','three']] },
    ])
  })

  it('keeps nested list children and paragraph text in the original block shape', () => {
    const blocks = parseMessageBlocks('- Parent\n  - Child\n- Second')
    expect(blocks).toEqual([{ kind: 'unorderedList', items: [
      { paragraphs: ['Parent'], children: [{ kind: 'unorderedList', items: [{ paragraphs: ['Child'] }] }] },
      { paragraphs: ['Second'] },
    ] }])
  })

  it('keeps bold file links and external URLs clickable with their display labels', () => {
    const parser = createConversationInlineParser()
    expect(parser.parseInlineSegmentsUncached('**[`guide`](</workspace/path with spaces/a (one).md:12>)**')).toEqual([
      { kind: 'file', value: '/workspace/path with spaces/a (one).md:12', path: '/workspace/path with spaces/a (one).md', displayPath: 'guide', downloadName: 'a (one).md' },
    ])
    expect(parser.parseInlineSegmentsUncached('https://example.test/path')).toEqual([
      { kind: 'url', value: 'https://example.test/path', href: 'https://example.test/path' },
    ])
  })

  it('resolves thread links from an explicit app location without browser globals', () => {
    const plain = createConversationInlineParser()
    const nested = createConversationInlineParser(() => ({ origin: 'https://example.test', pathname: '/sidux' }))
    expect(plain.parseInlineSegmentsUncached('[thread](codex://threads/thread-a)')).toEqual([{ kind: 'url', value: 'thread', href: '/#/thread/thread-a' }])
    expect(nested.parseInlineSegmentsUncached('[thread](codex://threads/thread-a)')).toEqual([{ kind: 'url', value: 'thread', href: 'https://example.test/sidux/#/thread/thread-a' }])
  })

  it.each([
    ['./src/a.ts:12', '/workspace', '/codex-local-browse/workspace/src/a.ts'],
    ['file:///workspace/a%20b.md#L3', '/elsewhere', '/codex-local-browse/workspace/a%20b.md'],
    ['C:\\work\\a.ts:4', '', '/codex-local-browse/C:/work/a.ts'],
    ['../a.md', '/workspace/src', '/codex-local-browse/workspace/a.md'],
  ])('resolves %s with the original browse URL and line suffix rules', (value, cwd, expected) => {
    expect(toBrowseUrl(value, cwd)).toBe(expected)
  })

  it('clamps heading presentation to the existing six classes', () => {
    expect(headingTag(0)).toBe('h1')
    expect(headingTag(8)).toBe('h6')
    expect(headingClass(3)).toBe('message-heading-h3')
  })

  it.each(['`', '``'])('consumes matching %s wrappers around HTTP and Markdown links', (marker) => {
    const parser = createConversationInlineParser()
    expect(parser.parseInlineSegmentsUncached(`${marker}https://example.test/path${marker}`)).toEqual([
      { kind: 'url', value: 'https://example.test/path', href: 'https://example.test/path' },
    ])
    expect(parser.parseInlineSegmentsUncached(`before ${marker}[site](https://example.test/path)${marker} after`)).toEqual([
      { kind: 'text', value: 'before ' },
      { kind: 'url', value: 'site', href: 'https://example.test/path' },
      { kind: 'text', value: ' after' },
    ])
    expect(parser.parseInlineSegmentsUncached(`${marker}/workspace/a.md${marker}`)).toEqual([
      { kind: 'file', value: '/workspace/a.md', path: '/workspace/a.md', displayPath: '/workspace/a.md', downloadName: 'a.md' },
    ])
  })

  it.each([
    ['C:\\work\\a.ts:4:2', '', '/codex-local-browse/C:/work/a.ts'],
    ['/workspace/a.ts:4:2', '', '/codex-local-browse/workspace/a.ts'],
    ['./a.ts:4:2', '/workspace', '/codex-local-browse/workspace/a.ts'],
  ])('removes both line and column from %s browse paths', (value, cwd, expected) => {
    expect(toBrowseUrl(value, cwd)).toBe(expected)
  })

  it('retains plain inline code and unmatched markers', () => {
    const parser = createConversationInlineParser()
    expect(parser.parseInlineSegmentsUncached('`value + 1`')).toEqual([{ kind: 'code', value: 'value + 1' }])
    expect(parser.parseInlineSegmentsUncached('`https://example.test/path')).toEqual([
      { kind: 'text', value: '`' }, { kind: 'url', value: 'https://example.test/path', href: 'https://example.test/path' },
    ])
  })
})
