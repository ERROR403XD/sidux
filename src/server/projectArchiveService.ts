import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isVirtualProjectId, type VirtualProject } from '../projectOrganization.js'
import { asRecord, getErrorCode, getErrorMessage, normalizeStringRecord } from './httpUtils.js'
import { getCodexHomeDir, readNonEmptyString } from './runtimePaths.js'
import { readProjectArchiveMembers } from './projectOrganizationArchive.js'
import { readMergedThreadTitleCache, writeImportedThreadTitle } from './preferencesService.js'
import { getVirtualProjectStore, persistWorkspaceRoot, prependUniqueString, updateWorkspaceRootsState } from './workspaceStateService.js'
import { createProjectConversationDirectory } from './projectDirectoryService.js'
import { isSameOrDescendantPath, parseStoredProjectZip, streamProjectZip, toProjectZipFileName, type ProjectZipVirtualEntry } from './projectArchiveCodec.js'
import { readSessionMetaCwd, readSessionMetaId, readImportedSessionRecord, readStateDbThreadExportMetadata, registerImportedSessionsInStateDb, rewriteImportedSession, type ImportedSessionRecord, type ExportedThreadMetadata } from './importedSessionService.js'
import type { ServerResponse } from 'node:http'

type ArchiveFailure = { status: number; error: string }
type ArchiveExportPlan = {
  kind: 'virtual' | 'directory'
  fileNameSource: string
  cwd: string
  entries: ProjectZipVirtualEntry[] | null
  roots?: Array<{ root: string; prefix: string }>
}
type ProjectArchiveDependencies = {
  collectProjectChatZipEntries: (project: string | VirtualProject) => Promise<ProjectZipVirtualEntry[]>
  getErrorCode: (error: unknown) => string | null
  importProjectZip: (buffer: Buffer, parent: string) => Promise<{ projectPath: string; importedSessions: number }>
  isAbsolute: (path: string) => boolean
  isVirtualProjectId: (value: string) => boolean
  readProject: (id: string) => Promise<VirtualProject>
  resolve: (path: string) => string
  resolveAllowedProjectZipCwd: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ isDirectory(): boolean }>
  streamProjectZip: (root: string, response: ServerResponse, entries: ProjectZipVirtualEntry[], roots?: Array<{ root: string; prefix: string }>) => Promise<void>
  toProjectZipFileName: (cwd: string) => string
}

async function resolveAllowedProjectZipCwd(rawCwd: string): Promise<string> {
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) {
    throw new Error('cwd is not a directory')
  }
  return await realpath(cwd)
}

async function* walkFiles(root: string, current = root): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolutePath = join(current, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(root, absolutePath)
    } else if (entry.isFile()) {
      yield absolutePath
    }
  }
}

async function collectProjectChatZipEntries(projectRoot: string | VirtualProject): Promise<ProjectZipVirtualEntry[]> {
  const organization = typeof projectRoot === 'string' ? null : projectRoot
  const canonicalProjectRoots = await Promise.all((typeof projectRoot === 'string' ? [projectRoot] : projectRoot.cwds).map(path => realpath(path).catch(() => resolve(path))))
  const codexHome = getCodexHomeDir()
  const threadTitles = await readMergedThreadTitleCache()
  const stateDbThreadMetadata = await readStateDbThreadExportMetadata()
  const exportedTitles: Record<string, string> = {}
  const exportedConversationCwds: Record<string, string> = {}
  const exportedThreads: Record<string, ExportedThreadMetadata> = {}
  const roots = [
    { disk: join(codexHome, 'sessions'), zip: '.codex-project/chats/sessions' },
    { disk: join(codexHome, 'archived_sessions'), zip: '.codex-project/chats/archived_sessions' },
  ]
  const entries: ProjectZipVirtualEntry[] = [{
    path: '.codex-project/manifest.json',
    data: Buffer.from(JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      projectName: organization?.label || basename(canonicalProjectRoots[0] || '') || 'project',
      ...(organization ? { organization: { version: 1, members: organization.cwds.map((cwd, index) => ({ cwd, prefix: `files/${String(index + 1).padStart(6, '0')}/` })) } } : {}),
    }, null, 2)),
    mtime: new Date(),
  }]
  if (!canonicalProjectRoots.length) return entries

  for (const root of roots) {
    for await (const sessionPath of walkFiles(root.disk)) {
      if (extname(sessionPath) !== '.jsonl') continue
      let raw = ''
      try {
        raw = await readFile(sessionPath, 'utf8')
      } catch {
        continue
      }
      const sessionCwd = readSessionMetaCwd(raw)
      if (!sessionCwd) continue
      let canonicalSessionCwd = ''
      try {
        canonicalSessionCwd = await realpath(sessionCwd)
      } catch {
        canonicalSessionCwd = isAbsolute(sessionCwd) ? resolve(sessionCwd) : resolve(sessionCwd)
      }
      const memberIndex = canonicalProjectRoots.findIndex(root => organization ? root === canonicalSessionCwd : isSameOrDescendantPath(canonicalSessionCwd, root))
      if (memberIndex < 0) continue
      const rel = relative(root.disk, sessionPath).split(sep).join('/')
      const zipPath = `${root.zip}/${rel}`
      if (organization && sessionCwd !== organization.cwds[memberIndex]) exportedConversationCwds[zipPath] = organization.cwds[memberIndex]
      const sessionId = readSessionMetaId(raw)
      const stateMetadata = sessionId ? stateDbThreadMetadata.get(sessionId) : undefined
      const title = readNonEmptyString(stateMetadata?.title) || (sessionId ? readNonEmptyString(threadTitles.titles[sessionId]) : '')
      if (title) exportedTitles[zipPath] = title
      if (title || (stateMetadata?.updatedAtMs ?? 0) > 0) {
        exportedThreads[zipPath] = {
          title,
          updatedAtMs: stateMetadata?.updatedAtMs ?? 0,
        }
      }
      entries.push({
        path: zipPath,
        filePath: sessionPath,
        mtime: new Date(),
      })
    }
  }
  if (organization && Object.keys(exportedConversationCwds).length) {
    const manifest = JSON.parse(entries[0].data!.toString('utf8'))
    manifest.organization.conversationCwds = exportedConversationCwds
    entries[0].data = Buffer.from(JSON.stringify(manifest, null, 2))
  }
  if (Object.keys(exportedTitles).length > 0 || Object.keys(exportedThreads).length > 0) {
    entries.push({
      path: '.codex-project/chats/thread-titles.json',
      data: Buffer.from(JSON.stringify({ version: 2, titles: exportedTitles, threads: exportedThreads }, null, 2)),
      mtime: new Date(),
    })
  }
  return entries
}

async function importProjectZip(buffer: Buffer, destinationParent: string): Promise<{ projectPath: string; importedSessions: number }> {
  const entries = parseStoredProjectZip(buffer)
  const manifestEntry = entries.find((entry) => entry.path === '.codex-project/manifest.json' && !entry.isDirectory)
  let projectName = 'imported-project'
  let organizationManifest: unknown
  if (manifestEntry) {
    try {
      const manifest = asRecord(JSON.parse(manifestEntry.data.toString('utf8')) as unknown)
      projectName = readNonEmptyString(manifest?.projectName) || projectName
      organizationManifest = manifest?.organization
    } catch {
      projectName = 'imported-project'
    }
  }
  if (organizationManifest === undefined) projectName = projectName.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f]+/g, '').trim() || 'imported-project'
  const organizationMembers = readProjectArchiveMembers(organizationManifest)
  const conversationCwds = normalizeStringRecord(asRecord(organizationManifest)?.conversationCwds)
  const memberCwdForEntry = (entry: { path: string; data: Buffer }) => Object.hasOwn(conversationCwds, entry.path) ? conversationCwds[entry.path] : readSessionMetaCwd(entry.data.toString('utf8'))
  if (organizationMembers) {
    for (const entry of entries) {
      if (entry.path.startsWith('.codex-project/chats/')) {
        if (entry.path.endsWith('.jsonl') && !organizationMembers.some(member => member.cwd === memberCwdForEntry(entry))) throw new Error('Invalid project conversation membership')
      } else if (entry.path !== '.codex-project/manifest.json' && !organizationMembers.some(member => entry.path.startsWith(member.prefix))) {
        throw new Error('Invalid project file membership')
      }
    }
  }
  const titleEntry = entries.find((entry) => entry.path === '.codex-project/chats/thread-titles.json' && !entry.isDirectory)
  const importedThreadMetadata = new Map<string, ExportedThreadMetadata>()
  if (titleEntry) {
    try {
      const payload = asRecord(JSON.parse(titleEntry.data.toString('utf8')) as unknown)
      const titles = asRecord(payload?.titles)
      if (titles) {
        for (const [key, value] of Object.entries(titles)) {
          const title = readNonEmptyString(value)
          if (key && title) importedThreadMetadata.set(key, { title, updatedAtMs: 0 })
        }
      }
      const threads = asRecord(payload?.threads)
      if (threads) {
        for (const [key, value] of Object.entries(threads)) {
          const record = asRecord(value)
          const title = readNonEmptyString(record?.title) || importedThreadMetadata.get(key)?.title || ''
          const updatedAtMs = typeof record?.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
            ? Math.trunc(record.updatedAtMs)
            : 0
          if (key && (title || updatedAtMs > 0)) importedThreadMetadata.set(key, { title, updatedAtMs })
        }
      }
    } catch {
      // Ignore malformed optional title metadata; imported chats still fall back to first user messages.
    }
  }

  const parent = await realpath(destinationParent)
  let projectPath: string
  const memberTargets = new Map<string, string>()
  if (organizationMembers) {
    const project = await getVirtualProjectStore().save(undefined, projectName)
    projectPath = project.id
    for (const member of organizationMembers) {
      const directory = await createProjectConversationDirectory(basename(member.cwd), project.id)
      memberTargets.set(member.cwd, directory.cwd)
    }
  } else {
    projectPath = join(parent, projectName)
    for (let index = 2; existsSync(projectPath); index += 1) projectPath = join(parent, `${projectName}-${index}`)
    await mkdir(projectPath, { recursive: true })
  }

  let importedSessions = 0
  const importedSessionRecords: ImportedSessionRecord[] = []
  const importedSessionsRoot = join(getCodexHomeDir(), 'sessions')
  const chatEntries = entries
    .filter((entry) => entry.path.startsWith('.codex-project/chats/') && !entry.isDirectory && extname(entry.path) === '.jsonl')
    .map((entry) => {
      const importedMetadata = importedThreadMetadata.get(entry.path)
      const sourceSessionRaw = entry.data.toString('utf8')
      const targetCwd = organizationMembers ? memberTargets.get(memberCwdForEntry(entry))! : projectPath
      const sourceRecord = readImportedSessionRecord(sourceSessionRaw, entry.path, targetCwd, readSessionMetaId(sourceSessionRaw) || randomUUID(), importedMetadata?.title ?? '')
      const updatedAtMs = (importedMetadata?.updatedAtMs ?? 0) > 0 ? importedMetadata?.updatedAtMs ?? 0 : sourceRecord.updatedAtMs
      return { entry, importedMetadata, sourceSessionRaw, sourceRecord, updatedAtMs, targetCwd }
    })
    .sort((first, second) => second.updatedAtMs - first.updatedAtMs)

  for (const [index, chatEntry] of chatEntries.entries()) {
    const importedThreadId = randomUUID()
    const target = join(importedSessionsRoot, 'imported', `${String(index + 1).padStart(6, '0')}-${importedThreadId}.jsonl`)
    await mkdir(dirname(target), { recursive: true })
    const importedSessionRaw = rewriteImportedSession(chatEntry.sourceSessionRaw, chatEntry.targetCwd, importedThreadId)
    await writeFile(target, importedSessionRaw, 'utf8')
    const importedRecord = readImportedSessionRecord(importedSessionRaw, target, chatEntry.targetCwd, importedThreadId, chatEntry.importedMetadata?.title ?? '')
    if (chatEntry.updatedAtMs > 0) {
      importedRecord.updatedAtMs = chatEntry.updatedAtMs
      importedRecord.createdAtMs = Math.min(chatEntry.sourceRecord.createdAtMs, importedRecord.updatedAtMs)
      const updatedAtDate = new Date(chatEntry.updatedAtMs)
      await utimes(target, updatedAtDate, updatedAtDate).catch(() => {})
    }
    importedSessionRecords.push(importedRecord)
    if (importedRecord.title) await writeImportedThreadTitle(importedThreadId, importedRecord.title)
    importedSessions += 1
  }
  await registerImportedSessionsInStateDb(importedSessionRecords)

  for (const entry of entries) {
    if (entry.path.startsWith('.codex-project/chats/')) {
      continue
    }
    if (organizationMembers && entry.path === '.codex-project/manifest.json') continue
    const member = organizationMembers?.find(member => entry.path.startsWith(member.prefix))
    const targetRoot = member ? memberTargets.get(member.cwd)! : projectPath
    const target = join(targetRoot, member ? entry.path.slice(member.prefix.length) : entry.path)
    if (!isSameOrDescendantPath(target, targetRoot)) throw new Error('Project ZIP contains an unsafe path')
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
    }
  }

  if (organizationMembers) await updateWorkspaceRootsState(state => ({ ...state, projectOrder: prependUniqueString(projectPath, state.projectOrder) }))
  else await persistWorkspaceRoot(projectPath, projectName)
  return { projectPath, importedSessions }
}

export function createProjectArchiveService(invalidateThreadSearch: () => void, dependencies: ProjectArchiveDependencies = {
  collectProjectChatZipEntries, getErrorCode, importProjectZip, isAbsolute, isVirtualProjectId, resolve, resolveAllowedProjectZipCwd, stat, streamProjectZip, toProjectZipFileName,
  readProject: id => getVirtualProjectStore().get(id),
}) {
  const { collectProjectChatZipEntries, getErrorCode, importProjectZip, isAbsolute, isVirtualProjectId, readProject, resolve, resolveAllowedProjectZipCwd, stat, streamProjectZip, toProjectZipFileName } = dependencies
  return {
    async prepareExport(rawCwd: string, head: boolean): Promise<ArchiveExportPlan | ArchiveFailure> {
      if (isVirtualProjectId(rawCwd)) {
        const project = await readProject(rawCwd)
        const roots = await Promise.all(project.cwds.map(async (cwd, index) => ({
          root: await resolveAllowedProjectZipCwd(cwd),
          prefix: `files/${String(index + 1).padStart(6, '0')}/`,
        })))
        const entries = head ? [] : await collectProjectChatZipEntries(project)
        return { kind: 'virtual', fileNameSource: project.label, cwd: '', entries, roots }
      }
      if (!rawCwd) return { status: 400, error: 'Missing cwd' }
      let cwd = ''
      try {
        cwd = await resolveAllowedProjectZipCwd(rawCwd)
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to validate project')
        if (message === 'cwd is not a directory') return { status: 400, error: message }
        if (getErrorCode(error) === 'ENOENT') return { status: 404, error: 'cwd does not exist' }
        return { status: 403, error: message }
      }
      return { kind: 'directory', fileNameSource: cwd, cwd, entries: null }
    },

    readExportFileName: (plan: ArchiveExportPlan) => toProjectZipFileName(plan.fileNameSource),

    async writeExport(plan: ArchiveExportPlan, res: ServerResponse): Promise<void> {
      const entries = plan.entries ?? await collectProjectChatZipEntries(plan.cwd)
      await streamProjectZip(plan.cwd, res, entries, plan.roots)
    },

    async prepareImport(rawParent: string): Promise<{ parent: string } | ArchiveFailure> {
      if (!rawParent) return { status: 400, error: 'Missing parent' }
      const parent = isAbsolute(rawParent) ? rawParent : resolve(rawParent)
      try {
        const info = await stat(parent)
        if (!info.isDirectory()) return { status: 400, error: 'Destination folder is not a directory' }
      } catch {
        return { status: 404, error: 'Destination folder does not exist' }
      }
      return { parent }
    },

    async importProject(buffer: Buffer, parent: string) {
      const result = await importProjectZip(buffer, parent)
      invalidateThreadSearch()
      return result
    },
  }
}
