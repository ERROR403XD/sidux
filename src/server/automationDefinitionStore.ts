import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { normalizeAutomationModelSettings } from '../automationOptions.js'
import { isAbsoluteLikePath } from '../pathUtils.js'
import { isVirtualProjectId } from '../projectOrganization.js'
import { parseAutomationToml, serializeAutomationToml, writeAutomationFileAtomic, type ThreadAutomationRecord, type ThreadAutomationStatus } from './automationDefinition.js'

export function createAutomationDefinitionStore(
  home: string,
  decorate: (record: ThreadAutomationRecord) => ThreadAutomationRecord,
) {
  function getCodexAutomationsDir(): string {
    return join(home, 'automations')
  }

  function slugifyAutomationId(threadId: string, name: string): string {
    const preferred = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
    if (preferred) return preferred.slice(0, 48)
    const fallback = threadId.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
    return `heartbeat-${fallback.slice(0, 24) || randomBytes(4).toString('hex')}`
  }

  async function readAutomationRecordFromFile(filePath: string): Promise<ThreadAutomationRecord | null> {
    try {
      const record = parseAutomationToml(await readFile(filePath, 'utf8'), basename(dirname(filePath)))
      return record ? decorate(record) : record
    } catch {
      return null
    }
  }

  async function listThreadHeartbeatAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
    const automationRoot = getCodexAutomationsDir()
    const next: Record<string, ThreadAutomationRecord[]> = {}
    let entries
    try {
      entries = await readdir(automationRoot, { withFileTypes: true })
    } catch {
      return next
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
      if (!automation || automation.kind !== 'heartbeat' || !automation.targetThreadId) continue
      next[automation.targetThreadId] = [...(next[automation.targetThreadId] ?? []), automation]
    }

    for (const automations of Object.values(next)) {
      automations.sort((first, second) => {
        const firstCreatedAt = first.createdAtMs ?? 0
        const secondCreatedAt = second.createdAtMs ?? 0
        if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
        return first.id.localeCompare(second.id)
      })
    }

    return next
  }

  async function readThreadHeartbeatAutomations(threadId: string): Promise<ThreadAutomationRecord[]> {
    const all = await listThreadHeartbeatAutomations()
    return all[threadId] ?? []
  }

  async function readThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
    const automations = await readThreadHeartbeatAutomations(threadId)
    if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
    return automations[0] ?? null
  }

  function resolveUniqueAutomationId(existingIds: Set<string>, threadId: string, name: string): string {
    const baseId = slugifyAutomationId(threadId, name)
    if (!existingIds.has(baseId)) return baseId
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseId}-${index}`
      if (!existingIds.has(candidate)) return candidate
    }
    return `${baseId}-${randomBytes(4).toString('hex')}`
  }

  async function writeThreadHeartbeatAutomation(input: {
    threadId: string
    id?: string
    name: string
    prompt: string
    rrule: string
    status: ThreadAutomationStatus
    model?: unknown
    serviceTier?: unknown
    accountStorageId?: unknown
    protected?: unknown
    reasoningEffort?: unknown
    timezone?: string
  }): Promise<ThreadAutomationRecord> {
    const threadId = input.threadId.trim()
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    const rrule = input.rrule.trim()
    if (!threadId || !name || !prompt || !rrule) {
      throw new Error('threadId, name, prompt, and rrule are required')
    }

    const automationRoot = getCodexAutomationsDir()
    await mkdir(automationRoot, { recursive: true })
    const existing = input.id ? await readThreadHeartbeatAutomation(threadId, input.id.trim()) : null
    const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
    const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    const id = existing?.id ?? resolveUniqueAutomationId(existingIds, threadId, name)
    const automationDir = join(automationRoot, id)
    const now = Date.now()
    const record: ThreadAutomationRecord = {
      ...normalizeAutomationModelSettings(input, existing ?? {}),
      timezone: input.timezone ?? existing?.timezone,
      id,
      kind: 'heartbeat',
      name,
      prompt,
      rrule,
      status: input.status,
      targetThreadId: threadId,
      cwds: [],
      extraTomlLines: existing?.extraTomlLines ?? [],
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      nextRunAtMs: null,
    }

    await mkdir(automationDir, { recursive: true })
    await writeAutomationFileAtomic(join(automationDir, 'automation.toml'), serializeAutomationToml(record))
    const memoryPath = join(automationDir, 'memory.md')
    try {
      await stat(memoryPath)
    } catch {
      await writeFile(memoryPath, '', 'utf8')
    }
    return record
  }

  async function deleteThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<boolean> {
    const normalizedThreadId = threadId.trim()
    const normalizedAutomationId = automationId.trim()
    if (normalizedAutomationId) {
      const automation = await readThreadHeartbeatAutomation(normalizedThreadId, normalizedAutomationId)
      if (!automation) return false
      await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
      return true
    }

    const automations = await readThreadHeartbeatAutomations(normalizedThreadId)
    if (automations.length === 0) return false
    await Promise.all(automations.map((automation) => rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })))
    return true
  }

  async function listProjectCronAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
    const automationRoot = getCodexAutomationsDir()
    const next: Record<string, ThreadAutomationRecord[]> = {}
    let entries
    try {
      entries = await readdir(automationRoot, { withFileTypes: true })
    } catch {
      return next
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
      if (!automation || automation.kind !== 'cron' || automation.cwds.length === 0) continue
      for (const cwd of automation.cwds) {
        next[cwd] = [...(next[cwd] ?? []), automation]
      }
    }

    for (const automations of Object.values(next)) {
      automations.sort((first, second) => {
        const firstCreatedAt = first.createdAtMs ?? 0
        const secondCreatedAt = second.createdAtMs ?? 0
        if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
        return first.id.localeCompare(second.id)
      })
    }

    return next
  }

  async function readProjectCronAutomations(projectName: string): Promise<ThreadAutomationRecord[]> {
    const all = await listProjectCronAutomations()
    return all[projectName] ?? []
  }

  async function readProjectCronAutomation(projectName: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
    const automations = await readProjectCronAutomations(projectName)
    if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
    return automations[0] ?? null
  }

  async function writeProjectCronAutomation(input: {
    projectName: string
    id?: string
    name: string
    prompt: string
    rrule: string
    status: ThreadAutomationStatus
    model?: unknown
    serviceTier?: unknown
    accountStorageId?: unknown
    protected?: unknown
    reasoningEffort?: unknown
    timezone?: string
  }): Promise<ThreadAutomationRecord> {
    const projectName = input.projectName.trim()
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    const rrule = input.rrule.trim()
    if (!projectName || !name || !prompt || !rrule) {
      throw new Error('projectName, name, prompt, and rrule are required')
    }
    if (!isAbsoluteLikePath(projectName) && !isVirtualProjectId(projectName)) {
      throw new Error('Project automation cwd must be an absolute path')
    }

    const automationRoot = getCodexAutomationsDir()
    await mkdir(automationRoot, { recursive: true })
    const existing = input.id ? await readProjectCronAutomation(projectName, input.id.trim()) : null
    const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
    const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    const id = existing?.id ?? resolveUniqueAutomationId(existingIds, projectName, name)
    const automationDir = join(automationRoot, id)
    const now = Date.now()
    const record: ThreadAutomationRecord = {
      ...normalizeAutomationModelSettings(input, existing ?? {}),
      timezone: input.timezone ?? existing?.timezone,
      id,
      kind: 'cron',
      name,
      prompt,
      rrule,
      status: input.status,
      targetThreadId: null,
      cwds: Array.from(new Set([...(existing?.cwds ?? []), projectName])),
      extraTomlLines: existing?.extraTomlLines ?? [],
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      nextRunAtMs: null,
    }

    await mkdir(automationDir, { recursive: true })
    await writeAutomationFileAtomic(join(automationDir, 'automation.toml'), serializeAutomationToml(record))
    const memoryPath = join(automationDir, 'memory.md')
    try {
      await stat(memoryPath)
    } catch {
      await writeFile(memoryPath, '', 'utf8')
    }
    return record
  }

  async function deleteProjectCronAutomation(projectName: string, automationId = ''): Promise<boolean> {
    const normalizedProjectName = projectName.trim()
    const normalizedAutomationId = automationId.trim()
    if (!normalizedProjectName || (!isAbsoluteLikePath(normalizedProjectName) && !isVirtualProjectId(normalizedProjectName))) return false
    if (normalizedAutomationId) {
      const automation = await readProjectCronAutomation(normalizedProjectName, normalizedAutomationId)
      if (!automation) return false
      const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
      if (remainingCwds.length > 0) {
        const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
        await writeAutomationFileAtomic(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record))
      } else {
        await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
      }
      return true
    }

    const automations = await readProjectCronAutomations(normalizedProjectName)
    if (automations.length === 0) return false
    await Promise.all(automations.map(async (automation) => {
      const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
      if (remainingCwds.length > 0) {
        const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
        await writeAutomationFileAtomic(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record))
        return
      }
      await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
    }))
    return true
  }

  return {
    listThreadHeartbeatAutomations,
    readThreadHeartbeatAutomations,
    readThreadHeartbeatAutomation,
    writeThreadHeartbeatAutomation,
    deleteThreadHeartbeatAutomation,
    listProjectCronAutomations,
    readProjectCronAutomations,
    readProjectCronAutomation,
    writeProjectCronAutomation,
    deleteProjectCronAutomation,
  }
}
