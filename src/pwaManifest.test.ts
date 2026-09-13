import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

it('links the public manifest without an unnecessary credentials mode', () => {
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(html).not.toContain('crossorigin="use-credentials"')
})
