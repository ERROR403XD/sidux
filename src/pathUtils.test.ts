import { describe, expect, it } from 'vitest'
import { getPathLeafName, getPathParent, normalizePathForUi } from './pathUtils'

describe('path utilities', () => {
  it('normalizes Windows device prefixes without changing ordinary paths', () => {
    expect(normalizePathForUi('\\\\?\\C:\\repo\\src')).toBe('C:\\repo\\src')
    expect(normalizePathForUi('\\\\?\\UNC\\server\\share\\repo')).toBe('\\\\server\\share\\repo')
    expect(normalizePathForUi('/repo/src')).toBe('/repo/src')
  })

  it('returns leaf and parent across Windows and POSIX separators', () => {
    expect(getPathLeafName('/repo/src/Sidux/')).toBe('Sidux')
    expect(getPathParent('/repo/src/Sidux/')).toBe('/repo/src')
    expect(getPathLeafName('C:\\repo\\Sidux\\\\')).toBe('Sidux')
    expect(getPathParent('C:\\repo\\Sidux\\\\')).toBe('C:\\repo')
    expect(getPathLeafName('')).toBe('')
    expect(getPathParent('/')).toBe('')
  })
})
