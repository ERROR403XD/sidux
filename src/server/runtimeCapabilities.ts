import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveCodexCommand } from '../commandResolution.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'

export type CapabilitySnapshot = {
  cliVersion: string
  schemaHash: string
  generatedAt: string
  experimental: boolean
  methods: string[]
  notifications: string[]
  client: { dynamicModels: true; asyncQuestions: false; nativeHistoryPaging: false; toolSummaries: true }
}

export function extractProtocolMethods(payload: unknown): string[] {
  const root = payload as { oneOf?: Array<{ properties?: { method?: { enum?: unknown[]; const?: unknown } } }> }
  return [...new Set((root?.oneOf ?? []).flatMap(row => {
    const method = row.properties?.method
    return [...(method?.enum ?? []), method?.const].filter((value): value is string => typeof value === 'string' && !!value)
  }))].sort()
}

async function command(args: string[]): Promise<string> {
  const executable = resolveCodexCommand()
  if (!executable) throw new Error('Codex CLI is not available')
  const invocation = getSpawnInvocation(executable, args)
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI 能力检测超时')) }, 15000)
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr || `CLI capability command exited ${code}`))
    })
  })
}

export class MethodCatalog {
  private cache: { key: string; result: Promise<CapabilitySnapshot> } | null = null

  async snapshot(): Promise<CapabilitySnapshot> {
    const executable = resolveCodexCommand()
    const info = executable ? await stat(executable).catch(() => null) : null
    const key = `${executable}:${info?.mtimeMs}:${info?.size}`
    if (this.cache?.key === key) return this.cache.result
    const result = this.generate()
    const entry = { key, result }
    this.cache = entry
    result.catch(() => { if (this.cache === entry) this.cache = null })
    return result
  }

  private async generate(): Promise<CapabilitySnapshot> {
    const dir = await mkdtemp(join(tmpdir(), 'codexapp-capabilities-'))
    try {
      const cliVersion = await command(['--version'])
      let experimental = true
      try {
        await command(['app-server', 'generate-json-schema', '--experimental', '--out', dir])
      } catch {
        experimental = false
        await command(['app-server', 'generate-json-schema', '--out', dir])
      }
      const [requests, notifications] = await Promise.all([readFile(join(dir, 'ClientRequest.json'), 'utf8'), readFile(join(dir, 'ServerNotification.json'), 'utf8')])
      return {
        cliVersion, experimental, generatedAt: new Date().toISOString(),
        schemaHash: createHash('sha256').update(requests).update(notifications).digest('hex'),
        methods: extractProtocolMethods(JSON.parse(requests)), notifications: extractProtocolMethods(JSON.parse(notifications)),
        client: { dynamicModels: true, asyncQuestions: false, nativeHistoryPaging: false, toolSummaries: true },
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async listMethods(): Promise<string[]> { return (await this.snapshot()).methods }
  async listNotificationMethods(): Promise<string[]> { return (await this.snapshot()).notifications }
}
