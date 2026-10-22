import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'App.vue'), 'utf8')

describe('App template component imports', () => {
  it('resolves the account popover custom connections component', () => {
    expect(source).toContain('<CustomConnections @changed="onCustomConnectionsChanged" />')
    expect(source).toContain("import CustomConnections from './components/accounts/CustomConnections.vue'")
  })
})
