import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { asRecord } from './httpUtils.js'
import { queueGlobalStateMutation, readGlobalState, writeGlobalState } from './globalStateStore.js'
import { normalizeConversationPreferences, type ConversationPreferences, type ConversationPreferencePatch } from '../conversationPreferences.js'

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }

const MAX_THREAD_TITLES = 500
const EMPTY_THREAD_TITLE_CACHE: ThreadTitleCache = { titles: {}, order: [] }
const PINNED_THREAD_IDS_KEY = 'pinned-thread-ids'
const FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY = 'first-launch-plugins-card-dismissed'

type SessionIndexThreadTitle = {
  id: string
  title: string
  updatedAtMs: number
}

type SessionIndexThreadTitleCacheState = {
  fileSignature: string | null
  cache: ThreadTitleCache
}

let sessionIndexThreadTitleCacheState: SessionIndexThreadTitleCacheState = {
  fileSignature: null,
  cache: EMPTY_THREAD_TITLE_CACHE,
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeThreadTitleCache(value: unknown): ThreadTitleCache {
  const record = asRecord(value)
  if (!record) return EMPTY_THREAD_TITLE_CACHE
  const rawTitles = asRecord(record.titles)
  const titles: Record<string, string> = {}
  if (rawTitles) {
    for (const [id, title] of Object.entries(rawTitles)) {
      if (typeof title === 'string' && title.length > 0) titles[id] = title
    }
  }
  return { titles, order: normalizeStringArray(record.order) }
}

function normalizePinnedThreadIds(value: unknown): string[] {
  return normalizeStringArray(value)
}

function updateThreadTitleCache(cache: ThreadTitleCache, id: string, title: string): ThreadTitleCache {
  const titles = { ...cache.titles, [id]: title }
  const order = [id, ...cache.order.filter(item => item !== id)]
  while (order.length > MAX_THREAD_TITLES) {
    const removed = order.pop()
    if (removed) delete titles[removed]
  }
  return { titles, order }
}

function removeFromThreadTitleCache(cache: ThreadTitleCache, id: string): ThreadTitleCache {
  const { [id]: _, ...titles } = cache.titles
  return { titles, order: cache.order.filter(item => item !== id) }
}

function normalizeSessionIndexThreadTitle(value: unknown): SessionIndexThreadTitle | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.thread_name === 'string' ? record.thread_name.trim() : ''
  const updatedAtIso = typeof record.updated_at === 'string' ? record.updated_at.trim() : ''
  const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : Number.NaN

  if (!id || !title) return null
  return {
    id,
    title,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  }
}

function trimThreadTitleCache(cache: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...cache.titles }
  const order = cache.order.filter(id => titles[id]).slice(0, MAX_THREAD_TITLES)

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) delete titles[id]
  }

  return { titles, order }
}

function mergeThreadTitleCaches(base: ThreadTitleCache, overlay: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...base.titles, ...overlay.titles }
  const order: string[] = []

  for (const id of [...overlay.order, ...base.order]) {
    if (!titles[id] || order.includes(id)) continue
    order.push(id)
  }

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) order.push(id)
  }

  return trimThreadTitleCache({ titles, order })
}

async function readThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const payload = asRecord(JSON.parse(await readFile(getCodexGlobalStatePath(), 'utf8'))) ?? {}
    return normalizeThreadTitleCache(payload['thread-titles'])
  } catch {
    return EMPTY_THREAD_TITLE_CACHE
  }
}

export async function readMergedThreadTitleCache(): Promise<ThreadTitleCache> {
  const [sessionIndexCache, persistedCache] = await Promise.all([
    readThreadTitlesFromSessionIndex(),
    readThreadTitleCache(),
  ])
  return mergeThreadTitleCaches(persistedCache, sessionIndexCache)
}

async function readThreadTitlesFromSessionIndex(): Promise<ThreadTitleCache> {
  const sessionIndexPath = join(getCodexHomeDir(), 'session_index.jsonl')

  try {
    const stats = await stat(sessionIndexPath)
    const fileSignature = `${String(stats.mtimeMs)}:${String(stats.size)}`
    if (sessionIndexThreadTitleCacheState.fileSignature === fileSignature) {
      return sessionIndexThreadTitleCacheState.cache
    }

    const cache = await parseThreadTitlesFromSessionIndex(sessionIndexPath)
    sessionIndexThreadTitleCacheState = { fileSignature, cache }
    return cache
  } catch {
    sessionIndexThreadTitleCacheState = {
      fileSignature: 'missing',
      cache: EMPTY_THREAD_TITLE_CACHE,
    }
    return sessionIndexThreadTitleCacheState.cache
  }
}

async function parseThreadTitlesFromSessionIndex(sessionIndexPath: string): Promise<ThreadTitleCache> {
  const latestById = new Map<string, SessionIndexThreadTitle>()
  const input = createReadStream(sessionIndexPath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const entry = normalizeSessionIndexThreadTitle(JSON.parse(trimmed) as unknown)
        if (!entry) continue

        const previous = latestById.get(entry.id)
        if (!previous || entry.updatedAtMs >= previous.updatedAtMs) latestById.set(entry.id, entry)
      } catch {
        // Skip malformed lines and keep scanning the rest of the index.
      }
    }
  } finally {
    lines.close()
    input.close()
  }

  const entries = Array.from(latestById.values()).sort((first, second) => second.updatedAtMs - first.updatedAtMs)
  const titles: Record<string, string> = {}
  const order: string[] = []
  for (const entry of entries) {
    titles[entry.id] = entry.title
    order.push(entry.id)
  }

  return trimThreadTitleCache({ titles, order })
}

async function writeThreadTitleCache(cache: ThreadTitleCache): Promise<void> {
  const payload = await readGlobalState(getCodexGlobalStatePath())
  payload['thread-titles'] = cache
  await writeGlobalState(getCodexGlobalStatePath(), payload)
}

async function readPinnedThreadIds(): Promise<string[]> {
  try {
    const payload = asRecord(JSON.parse(await readFile(getCodexGlobalStatePath(), 'utf8'))) ?? {}
    return normalizePinnedThreadIds(payload[PINNED_THREAD_IDS_KEY])
  } catch {
    return []
  }
}

async function writePinnedThreadIds(threadIds: string[]): Promise<void> {
  const payload = await readGlobalState(getCodexGlobalStatePath())
  payload[PINNED_THREAD_IDS_KEY] = normalizePinnedThreadIds(threadIds)
  await writeGlobalState(getCodexGlobalStatePath(), payload)
}

async function readFirstLaunchPluginsCardDismissed(): Promise<boolean> {
  try {
    const payload = asRecord(JSON.parse(await readFile(getCodexGlobalStatePath(), 'utf8'))) ?? {}
    return payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] === true
  } catch {
    return false
  }
}

async function writeFirstLaunchPluginsCardDismissed(dismissed: boolean): Promise<void> {
  const payload = await readGlobalState(getCodexGlobalStatePath())
  payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] = dismissed === true
  await writeGlobalState(getCodexGlobalStatePath(), payload)
}

async function updateThreadTitle(id: string, title: string): Promise<void> {
  const cache = await readThreadTitleCache()
  const next = title ? updateThreadTitleCache(cache, id, title) : removeFromThreadTitleCache(cache, id)
  await writeThreadTitleCache(next)
}

export async function writeImportedThreadTitle(id: string, title: string): Promise<void> {
  await queueGlobalStateMutation(getCodexGlobalStatePath(), () => updateThreadTitle(id, title))
}

type PreferencesServiceDependencies = {
  mutateGlobalState: <T>(mutation: () => Promise<T>) => Promise<T>
  invalidateThreadSearch: (threadId?: string) => void
}

export function createPreferencesService(dependencies: PreferencesServiceDependencies) {
  const { mutateGlobalState, invalidateThreadSearch } = dependencies
  const conversationPath = () => join(getCodexHomeDir(), 'codexapp-conversation-preferences.json')
  return {
    async readConversationPreferences(threadId: string): Promise<ConversationPreferences> {
      const preferences = normalizeConversationPreferences(await readGlobalState(conversationPath()))
      return { ...preferences, threads: Object.fromEntries(Object.entries(preferences.threads).filter(([id]) => id === threadId)) }
    },
    async saveConversationPreferences(patch: ConversationPreferencePatch): Promise<void> {
      const path = conversationPath()
      await queueGlobalStateMutation(path, async () => {
        const raw = await readGlobalState(path)
        const current = normalizeConversationPreferences(raw)
        const migrated = normalizeConversationPreferences(patch.migrate)
        const incoming = normalizeConversationPreferences(patch)
        const next: ConversationPreferences = {
          defaults: 'defaults' in patch ? incoming.defaults : 'defaults' in raw ? current.defaults : migrated.defaults,
          remember: 'remember' in patch ? incoming.remember : 'remember' in raw ? current.remember : migrated.remember,
          threads: { ...migrated.threads, ...current.threads, ...incoming.threads },
        }
        await writeGlobalState(path, { ...next })
      })
    },
    readTitles: readMergedThreadTitleCache,
    readPins: readPinnedThreadIds,
    readFirstLaunchDismissed: readFirstLaunchPluginsCardDismissed,
    async saveTitle(id: string, title: string): Promise<void> {
      await mutateGlobalState(() => updateThreadTitle(id, title))
      invalidateThreadSearch(id)
    },
    async savePins(input: unknown): Promise<void> {
      const threadIds = normalizePinnedThreadIds(input)
      await mutateGlobalState(() => writePinnedThreadIds(threadIds))
    },
    async saveFirstLaunchDismissed(dismissed: boolean): Promise<void> {
      await mutateGlobalState(() => writeFirstLaunchPluginsCardDismissed(dismissed))
    },
  }
}
