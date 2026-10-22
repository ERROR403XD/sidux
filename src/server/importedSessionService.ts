import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { asRecord } from './httpUtils.js'
import { getCodexHomeDir, readNonEmptyString } from './runtimePaths.js'
import { ensureDefaultFreeModeStateForMissingAuthSync } from './appServerRuntimeDependencies.js'
import { FREE_MODE_STATE_FILE, FREE_MODE_DEFAULT_MODEL, OPENCODE_ZEN_DEFAULT_MODEL } from './freeMode.js'
import { maySupplementImportedThreads } from './threadListCompatibility.js'

export type ImportedSessionRecord = {
  id: string
  path: string
  cwd: string
  title: string
  createdAtMs: number
  updatedAtMs: number
  model: string
  modelProvider: string
  cliVersion: string
  firstUserMessage: string
}

export type ExportedThreadMetadata = {
  title: string
  updatedAtMs: number
}

export function readSessionMetaCwd(raw: string): string {
  const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim()
  if (!firstLine) return ''
  try {
    const parsed = JSON.parse(firstLine) as unknown
    const record = asRecord(parsed)
    const payload = asRecord(record?.payload)
    return readNonEmptyString(payload?.cwd)
  } catch {
    return ''
  }
}

export function readSessionMetaId(raw: string): string {
  const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim()
  if (!firstLine) return ''
  try {
    const parsed = JSON.parse(firstLine) as unknown
    const record = asRecord(parsed)
    const payload = asRecord(record?.payload)
    return readNonEmptyString(payload?.id)
  } catch {
    return ''
  }
}

function getCurrentImportedSessionModelDefaults(): { model: string; modelProvider: string } | null {
  const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
  if (!fmState?.enabled) return null
  if (fmState.provider === 'opencode-zen') {
    return {
      model: fmState.model?.trim() || OPENCODE_ZEN_DEFAULT_MODEL,
      modelProvider: 'opencode_zen',
    }
  }
  if (fmState.provider === 'custom' && fmState.customBaseUrl?.trim()) {
    return {
      model: fmState.model?.trim() || '',
      modelProvider: 'custom_endpoint',
    }
  }
  if (fmState.apiKey?.trim()) {
    return {
      model: fmState.model?.trim() || FREE_MODE_DEFAULT_MODEL,
      modelProvider: 'openrouter_free',
    }
  }
  return null
}

export function rewriteImportedSession(raw: string, importedCwd: string, importedThreadId: string): string {
  const lines: string[] = []
  let hasUserMessageEvent = false
  const modelDefaults = getCurrentImportedSessionModelDefaults()
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      const payload = asRecord(record?.payload)
      if (record?.type === 'event_msg' && readNonEmptyString(payload?.type) === 'user_message') {
        hasUserMessageEvent = true
      }
      if (payload && typeof payload.cwd === 'string') {
        payload.cwd = importedCwd
      }
      if (record?.type === 'session_meta' && payload) {
        payload.id = importedThreadId
        payload.source = 'cli'
        payload.imported = true
        if (!readNonEmptyString(payload.originator)) {
          payload.originator = 'codex_cli_rs'
        }
        if (modelDefaults) {
          payload.model = modelDefaults.model
          payload.model_provider = modelDefaults.modelProvider
        }
      }
      lines.push(JSON.stringify(parsed))
      if (!hasUserMessageEvent && payload && record?.type === 'response_item' && readNonEmptyString(payload.role) === 'user') {
        const content = Array.isArray(payload.content) ? payload.content : []
        const text = content
          .map((item) => readNonEmptyString(asRecord(item)?.text))
          .find((value) => value.length > 0)
        if (text) {
          lines.push(JSON.stringify({
            timestamp: readNonEmptyString(record.timestamp) || new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: text, images: [] },
          }))
          hasUserMessageEvent = true
        }
      }
    } catch {
      lines.push(line)
    }
  }
  return `${lines.join('\n')}\n`
}

export function readImportedSessionRecord(raw: string, path: string, cwd: string, fallbackId: string, importedTitle = ''): ImportedSessionRecord {
  let id = fallbackId
  let createdAtMs = Date.now()
  let updatedAtMs = 0
  let model = ''
  let modelProvider = 'openai'
  let cliVersion = ''
  let firstUserMessage = ''
  const title = importedTitle.trim()

  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      const payload = asRecord(record?.payload)
      const timestamp = readNonEmptyString(record?.timestamp) || readNonEmptyString(payload?.timestamp)
      const timeMs = timestamp ? Date.parse(timestamp) : NaN
      if (Number.isFinite(timeMs)) {
        updatedAtMs = Math.max(updatedAtMs, timeMs)
      }
      if (record?.type === 'session_meta' && payload) {
        id = readNonEmptyString(payload.id) || id
        const metaTime = readNonEmptyString(payload.timestamp)
        const metaMs = metaTime ? Date.parse(metaTime) : NaN
        if (Number.isFinite(metaMs)) createdAtMs = metaMs
        model = readNonEmptyString(payload.model) || model
        modelProvider = readNonEmptyString(payload.model_provider) || modelProvider
        cliVersion = readNonEmptyString(payload.cli_version) || cliVersion
      }
      if (!firstUserMessage && record?.type === 'event_msg' && readNonEmptyString(payload?.type) === 'user_message') {
        firstUserMessage = readNonEmptyString(payload?.message)
      }
      if (!firstUserMessage && record?.type === 'response_item') {
        const role = readNonEmptyString(payload?.role)
        if (role === 'user') {
          const content = Array.isArray(payload?.content) ? payload.content : []
          for (const item of content) {
            const itemRecord = asRecord(item)
            const text = readNonEmptyString(itemRecord?.text)
            if (text) {
              firstUserMessage = text
              break
            }
          }
        }
      }
    } catch {
      continue
    }
  }

  const now = Date.now()
  createdAtMs = Math.min(createdAtMs, now)
  if (updatedAtMs <= 0) updatedAtMs = createdAtMs
  updatedAtMs = Math.min(Math.max(updatedAtMs, createdAtMs), now)
  return { id, path, cwd, title, createdAtMs, updatedAtMs, model, modelProvider, cliVersion, firstUserMessage }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function ensureImportedThreadsStateDbTable(stateDbPath: string): Promise<boolean> {
  const sql = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  source TEXT,
  model TEXT,
  model_provider TEXT,
  cwd TEXT,
  title TEXT,
  sandbox_policy TEXT,
  approval_mode TEXT,
  tokens_used INTEGER,
  has_user_event INTEGER,
  archived INTEGER,
  archived_at INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  cli_version TEXT,
  first_user_message TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  thread_source TEXT,
  preview TEXT
);`
  return await execSqlite(stateDbPath, [sql]) !== null
}

async function execSqlite(stateDbPath: string, args: string[]): Promise<string | null> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile('sqlite3', [stateDbPath, ...args], { encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string }
    console.warn('[project-import] sqlite3 failed', failure.stderr || failure.stdout || (error instanceof Error ? error.message : error))
    return null
  }
}

function buildImportedSessionStateDbValues(session: ImportedSessionRecord): Record<string, string> {
  const title = session.title || session.firstUserMessage || 'Imported chat'
  const createdAt = Math.floor(session.createdAtMs / 1000)
  const updatedAt = Math.floor(session.updatedAtMs / 1000)
  const sandboxPolicy = JSON.stringify({ type: 'workspace-write', network_access: true })
  return {
    id: sqlString(session.id),
    rollout_path: sqlString(session.path),
    created_at: String(createdAt),
    updated_at: String(updatedAt),
    source: "'cli'",
    model: sqlString(session.model),
    model_provider: sqlString(session.modelProvider),
    cwd: sqlString(session.cwd),
    title: sqlString(title),
    sandbox_policy: sqlString(sandboxPolicy),
    approval_mode: "'on-request'",
    tokens_used: '0',
    has_user_event: '1',
    archived: '0',
    archived_at: 'NULL',
    git_sha: 'NULL',
    git_branch: 'NULL',
    git_origin_url: 'NULL',
    cli_version: sqlString(session.cliVersion),
    first_user_message: sqlString(session.firstUserMessage),
    created_at_ms: String(Math.trunc(session.createdAtMs)),
    updated_at_ms: String(Math.trunc(session.updatedAtMs)),
    thread_source: "'user'",
    preview: sqlString(title),
  }
}

export async function registerImportedSessionsInStateDb(sessions: ImportedSessionRecord[]): Promise<void> {
  if (sessions.length === 0) return
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!await ensureImportedThreadsStateDbTable(stateDbPath)) return
  const pragma = await execSqlite(stateDbPath, ['PRAGMA table_info(threads);'])
  if (pragma === null) return
  const availableColumns = new Set(pragma
    .split(/\r?\n/u)
    .map((line) => line.split('|')[1])
    .filter((value): value is string => Boolean(value)))
  const values = buildImportedSessionStateDbValues(sessions[0])
  const columns = Object.keys(values).filter((column) => availableColumns.has(column))
  const inserts = sessions.map((session) => {
    const sessionValues = buildImportedSessionStateDbValues(session)
    return `INSERT OR REPLACE INTO threads (${columns.join(', ')}) VALUES (${columns.map((column) => sessionValues[column]).join(', ')});`
  })
  const sql = ['BEGIN;', ...inserts, 'COMMIT;'].join('\n')
  await execSqlite(stateDbPath, [sql])
}

async function listImportedThreadsFromStateDb(): Promise<Array<Record<string, unknown>>> {
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!await stat(stateDbPath).then(() => true, () => false)) return []
  const sql = `
SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
       cli_version, first_user_message, archived
FROM threads
WHERE archived = 0 AND replace(rollout_path, '\\', '/') LIKE '%/sessions/%' AND id IN (
  SELECT id FROM threads WHERE first_user_message != '' OR title != ''
)
ORDER BY updated_at DESC
LIMIT 200;
`
  const raw = await execSqlite(stateDbPath, ['-json', sql])
  if (raw === null || !raw.trim()) return []
  try {
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) => {
      const record = asRecord(row)
      const id = readNonEmptyString(record?.id)
      const path = readNonEmptyString(record?.rollout_path)
      const cwd = readNonEmptyString(record?.cwd)
      if (!id || !path || !cwd) return []
      const title = readNonEmptyString(record?.title) || readNonEmptyString(record?.first_user_message) || 'Imported chat'
      const createdAt = typeof record?.created_at === 'number' ? record.created_at : Math.floor(Date.now() / 1000)
      const updatedAt = typeof record?.updated_at === 'number' ? record.updated_at : createdAt
      return [{
        id,
        preview: title,
        modelProvider: readNonEmptyString(record?.model_provider) || 'openai',
        createdAt,
        updatedAt,
        path,
        cwd,
        cliVersion: readNonEmptyString(record?.cli_version),
        source: 'cli',
        gitInfo: null,
        turns: [],
      }]
    })
  } catch {
    return []
  }
}

export async function readStateDbThreadExportMetadata(): Promise<Map<string, ExportedThreadMetadata>> {
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!await stat(stateDbPath).then(() => true, () => false)) return new Map()
  const pragma = await execSqlite(stateDbPath, ['PRAGMA table_info(threads);'])
  if (pragma === null) return new Map()
  const availableColumns = new Set(pragma
    .split(/\r?\n/u)
    .map((line) => line.split('|')[1])
    .filter((value): value is string => Boolean(value)))
  if (!availableColumns.has('id')) return new Map()
  const selectColumns = [
    'id',
    availableColumns.has('title') ? 'title' : "'' AS title",
    availableColumns.has('preview') ? 'preview' : "'' AS preview",
    availableColumns.has('updated_at') ? 'updated_at' : '0 AS updated_at',
    availableColumns.has('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms',
  ]
  const archivedPredicate = availableColumns.has('archived') ? 'WHERE archived = 0' : ''
  const sql = `
SELECT ${selectColumns.join(', ')}
FROM threads
${archivedPredicate};
`
  const raw = await execSqlite(stateDbPath, ['-json', sql])
  if (raw === null || !raw.trim()) return new Map()
  try {
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return new Map()
    const metadata = new Map<string, ExportedThreadMetadata>()
    for (const row of rows) {
      const record = asRecord(row)
      const id = readNonEmptyString(record?.id)
      if (!id) continue
      const title = readNonEmptyString(record?.title) || readNonEmptyString(record?.preview)
      const updatedAtMs =
        typeof record?.updated_at_ms === 'number' && Number.isFinite(record.updated_at_ms)
          ? Math.trunc(record.updated_at_ms)
          : typeof record?.updated_at === 'number' && Number.isFinite(record.updated_at)
            ? Math.trunc(record.updated_at * 1000)
            : 0
      if (!title && updatedAtMs <= 0) continue
      metadata.set(id, { title, updatedAtMs })
    }
    return metadata
  } catch {
    return new Map()
  }
}

export async function mergeImportedThreadsIntoThreadListResult(result: unknown, params: unknown): Promise<unknown> {
  if (!maySupplementImportedThreads(params)) return result
  const record = asRecord(result)
  const data = Array.isArray(record?.data) ? record.data : null
  if (!record || !data) return result
  const importedById = new Map<string, Record<string, unknown>>()
  for (const thread of await listImportedThreadsFromStateDb()) {
    const id = readNonEmptyString(thread.id)
    if (id) importedById.set(id, thread)
  }
  if (importedById.size === 0) return result
  const mergedData: unknown[] = []
  for (const item of data) {
    const id = readNonEmptyString(asRecord(item)?.id)
    const imported = id ? importedById.get(id) : undefined
    if (imported) {
      mergedData.push({ ...asRecord(item), ...imported })
      importedById.delete(id)
    } else {
      mergedData.push(item)
    }
  }
  mergedData.push(...importedById.values())
  return {
    ...record,
    data: mergedData.sort((a, b) => {
      const aUpdated = typeof asRecord(a)?.updatedAt === 'number' ? asRecord(a)?.updatedAt as number : 0
      const bUpdated = typeof asRecord(b)?.updatedAt === 'number' ? asRecord(b)?.updatedAt as number : 0
      return bUpdated - aUpdated
    }),
  }
}
