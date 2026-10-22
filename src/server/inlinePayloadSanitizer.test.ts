import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeThreadTurnsInlinePayloads } from './inlinePayloadSanitizer.js'

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

describe('inline payload sanitizer', () => {
  it('persists image data only once and preserves existing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inline-payload-sanitizer-'))
    const mediaPath = join(tmpdir(), 'codex-web-inline-media')
    try {
      const first = await sanitizeThreadTurnsInlinePayloads('thread/read', {
        thread: { turns: [{ id: 'turn-1', items: [{ id: 'item-1', type: 'userMessage', content: [{ type: 'image', url: pngDataUrl }] }] }] },
      }) as { thread: { turns: Array<{ items: Array<{ content: Array<{ url: string }> }> }> } }
      const url = first.thread.turns[0].items[0].content[0].url
      expect(url).toMatch(/^\/codex-local-image\?path=/)
      const imagePath = new URL(url, 'http://localhost').searchParams.get('path')
      expect(imagePath).toBeTruthy()
      expect(existsSync(imagePath!)).toBe(true)
      const before = await readFile(imagePath!, 'utf8')
      await writeFile(imagePath!, before)
      const second = await sanitizeThreadTurnsInlinePayloads('thread/read', first) as typeof first
      expect(new URL(second.thread.turns[0].items[0].content[0].url, 'http://localhost').searchParams.get('path')).toBe(imagePath)
      expect(await readFile(imagePath!, 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not process methods without thread turns', async () => {
    const payload = { thread: { turns: [{ id: 'turn-1', items: [{ id: 'item-1', type: 'userMessage', content: [{ type: 'image', url: pngDataUrl }] }] }] } }
    await expect(sanitizeThreadTurnsInlinePayloads('thread/list', payload)).resolves.toBe(payload)
  })
})
