import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCommand, runCommandCapture, runCommandCaptureRaw } from './commandExecution.js'

it('captures stdout without stderr and trims only at the capture boundary', async () => {
  const output = await runCommandCapture(process.execPath, ['-e', 'process.stdout.write(" out\\n ")'])
  expect(output).toBe('out')
  await expect(runCommandCaptureRaw(process.execPath, ['-e', 'process.stdout.write(" raw\\0 ")'])).resolves.toBe(' raw\0 ')
})

it('rejects failures with command details and applies the timeout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'command-execution-'))
  const script = join(home, 'fail.js')
  await writeFile(script, 'console.error("boom"); process.exit(7)\n')
  await expect(runCommand(process.execPath, [script])).rejects.toThrow('Command failed')
  await expect(runCommand('sleep', ['2'], { cwd: home, timeoutMs: 20 })).rejects.toThrow('Command timed out after 20ms')
}, 5000)
