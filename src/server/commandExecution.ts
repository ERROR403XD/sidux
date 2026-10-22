import { spawn } from 'node:child_process'

export async function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let closed = false
    const timeout =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true
          proc.kill('SIGTERM')
          setTimeout(() => {
            if (!closed) proc.kill('SIGKILL')
          }, 5_000).unref()
        }, options.timeoutMs)
        : null
    timeout?.unref()
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    proc.on('close', (code) => {
      closed = true
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`Command timed out after ${options.timeoutMs}ms (${command} ${args.join(' ')})`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

export async function runCommandCaptureBuffer(command: string, args: string[], options: { cwd?: string } = {}): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      const details = [stderr.trim(), Buffer.concat(stdout).toString().trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

export async function runCommandCaptureRaw(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return (await runCommandCaptureBuffer(command, args, options)).toString()
}

export async function runCommandCapture(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return (await runCommandCaptureRaw(command, args, options)).trim()
}
