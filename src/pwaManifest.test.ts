import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))

it('links the public manifest without an unnecessary credentials mode', () => {
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(html).not.toContain('crossorigin="use-credentials"')
})

it('uses the Sidux product name in the document and install manifest', () => {
  expect(html).toContain('<title>Sidux</title>')
  expect(html).toContain('name="application-name" content="Sidux"')
  expect(manifest.name).toBe('Sidux')
  expect(manifest.short_name).toBe('Sidux')
})
