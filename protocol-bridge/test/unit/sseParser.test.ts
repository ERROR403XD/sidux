import { describe, expect, it } from 'vitest'
import { SseParser } from '../../src/sse/parser.js'
import { ProtocolParseError } from '../../src/errors.js'

function parseAll(transcript: string): Array<{ data: string; event?: string }> {
  const parser = new SseParser({})
  return [...parser.push(transcript), ...parser.flush()]
}

describe('SseParser', () => {
  it('parses a single data frame', () => {
    expect(parseAll('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('parses multiple frames inside one chunk', () => {
    const messages = parseAll('data: one\n\ndata: two\n\ndata: three\n\n')
    expect(messages.map(message => message.data)).toEqual(['one', 'two', 'three'])
  })

  it('reassembles one frame split across chunks', () => {
    const parser = new SseParser({})
    expect(parser.push('data: hel')).toEqual([])
    expect(parser.push('lo wor')).toEqual([])
    expect(parser.push('ld\n\n')).toEqual([{ data: 'hello world' }])
  })

  it('handles CRLF line endings', () => {
    expect(parseAll('data: one\r\n\r\ndata: two\r\n\r\n')).toEqual([{ data: 'one' }, { data: 'two' }])
  })

  it('joins multi-line data fields with newlines', () => {
    expect(parseAll('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }])
  })

  it('tolerates data: without a space after the colon', () => {
    expect(parseAll('data:{"a":1}\n\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('captures event and id fields and ignores comments', () => {
    const messages = parseAll(': keep-alive comment\nevent: delta\nid: 42\ndata: body\n\n')
    expect(messages).toEqual([{ data: 'body', event: 'delta', id: '42' }])
  })

  it('keeps UTF-8 multi-byte characters intact across arbitrary chunk splits', () => {
    // 你 is 3 bytes, 🌍 is 4 bytes; every split point must decode cleanly.
    const payload = JSON.stringify({ text: '你好🌍世界' })
    const transcript = `data: ${payload}\n\n`
    const bytes = Buffer.from(transcript, 'utf8')
    for (let size = 1; size <= bytes.length; size++) {
      const parser = new SseParser({})
      const messages = [...parser.push(bytes.subarray(0, size)), ...parser.push(bytes.subarray(size)), ...parser.flush()]
      expect(messages, `split at ${size}`).toEqual([{ data: payload }])
    }
  })

  it('ignores empty lines that carry no data', () => {
    expect(parseAll('\n\n\n')).toEqual([])
    expect(parseAll('event: ping\n\ndata: x\n\n')).toEqual([{ data: 'x' }])
  })

  it('flushes a trailing frame missing its final newline', () => {
    expect(parseAll('data: tail')).toEqual([{ data: 'tail' }])
  })

  it('drops everything after an unterminated oversized frame', () => {
    const parser = new SseParser({ maxBufferBytes: 16 })
    expect(() => parser.push('data: ' + 'x'.repeat(64))).toThrow(ProtocolParseError)
    // After the failure the parser resets and keeps working.
    expect(parser.push('data: ok\n\n')).toEqual([{ data: 'ok' }])
  })
})
