import { describe, expect, it } from 'vitest'
import { getPotentialCodexExecutables, getPotentialRipgrepExecutables } from './commandResolution.js'
import { join } from 'node:path'

const prefix = process.platform === 'win32' ? 'C:\\npm-global' : '/usr/local'

describe('codex vendor executable candidates', () => {
  it.skipIf(process.platform !== 'win32')('covers both pre-0.155 and current vendor layouts on Windows', () => {
    const codex = getPotentialCodexExecutables(prefix)
    expect(codex.some((path) => path.endsWith(join('vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')))).toBe(true)
    expect(codex.some((path) => path.endsWith(join('vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')))).toBe(true)
    const rg = getPotentialRipgrepExecutables(prefix)
    expect(rg.some((path) => path.endsWith(join('vendor', 'x86_64-pc-windows-msvc', 'codex-path', 'rg.exe')))).toBe(true)
    expect(rg.some((path) => path.endsWith(join('vendor', 'x86_64-pc-windows-msvc', 'path', 'rg.exe')))).toBe(true)
    for (const path of [...codex, ...rg]) expect(path.startsWith(prefix)).toBe(true)
  })
  it.skipIf(process.platform === 'win32')('keeps the posix layouts unchanged', () => {
    // POSIX global installs resolve under both the flat npm prefix and the lib layout.
    expect(getPotentialCodexExecutables(prefix)).toEqual([
      join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex'),
      join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex'),
    ])
    expect(getPotentialRipgrepExecutables(prefix)).toEqual([
      join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'rg'),
      join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'rg'),
    ])
  })
})
