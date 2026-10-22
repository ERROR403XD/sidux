import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { asRecord } from './httpUtils.js'

export type SessionRecoveredSkillInput = {
  name: string
  path: string
}

type SessionSkillInputCacheEntry = {
  size: number
  boundary: string
  mtimeNs: bigint
  ctimeNs: bigint
  inode: bigint
  offset: number
  currentTurnId: string
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>
}

const SESSION_SKILL_INPUT_CACHE_LIMIT = 64
const sessionSkillInputCache = new Map<string, SessionSkillInputCacheEntry>()

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : ''
}

function parseSessionSkillText(value: string): SessionRecoveredSkillInput | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('<skill>')) return null
  const name = trimmed.match(/<name>\s*([\s\S]*?)\s*<\/name>/u)?.[1]?.trim() ?? ''
  const path = trimmed.match(/<path>\s*([\s\S]*?)\s*<\/path>/u)?.[1]?.trim() ?? ''
  if (!name || !path) return null
  return { name, path }
}

function buildSessionSkillInputsByTurn(sessionLogRaw: string, state = { currentTurnId: '', skillsByTurnId: new Map<string, SessionRecoveredSkillInput[]>() }): Map<string, SessionRecoveredSkillInput[]> {
  const skillsByTurnId = state.skillsByTurnId

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.includes('<skill>') && !line.includes('turn_context') && !line.includes('task_started')) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const payloadRecord = asRecord(row.payload)
      state.currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || state.currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const payloadRecord = asRecord(row.payload)
      if (payloadRecord?.type === 'task_started') {
        state.currentTurnId = readNonEmptyString(payloadRecord.turn_id) || state.currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !state.currentTurnId) continue
    const payloadRecord = asRecord(row.payload)
    if (payloadRecord?.type !== 'message' || payloadRecord.role !== 'user') continue
    const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : []

    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem)
      if (contentRecord?.type !== 'input_text' || typeof contentRecord.text !== 'string') continue
      const skill = parseSessionSkillText(contentRecord.text)
      if (!skill) continue
      const existing = skillsByTurnId.get(state.currentTurnId) ?? []
      if (!existing.some(item => item.path === skill.path)) {
        existing.push(skill)
        skillsByTurnId.set(state.currentTurnId, existing)
      }
    }
  }

  return skillsByTurnId
}

async function readSessionBoundary(sessionPath: string, size: number): Promise<string> {
  const file = await open(sessionPath, 'r')
  try {
    const length = Math.min(4096, size)
    const head = Buffer.alloc(length)
    const tail = Buffer.alloc(length)
    await file.read(head, 0, length, 0)
    await file.read(tail, 0, length, Math.max(0, size - length))
    return createHash('sha256').update(head).update(tail).digest('hex')
  } finally {
    await file.close()
  }
}

export async function readCachedSessionSkillInputsByTurn(sessionPath: string): Promise<Map<string, SessionRecoveredSkillInput[]>> {
  const rawInfo = await stat(sessionPath, { bigint: true })
  const info = { ...rawInfo, size: Number(rawInfo.size) }
  const cached = sessionSkillInputCache.get(sessionPath)
  // Rapid rewrites can share filesystem timestamps. Check a bounded prefix and the old EOF too.
  const unchangedBoundary = cached && info.size >= cached.size && cached.inode === info.ino
    && await readSessionBoundary(sessionPath, cached.size) === cached.boundary
  if (cached && unchangedBoundary && cached.size === info.size && cached.mtimeNs === info.mtimeNs && cached.ctimeNs === info.ctimeNs) return cached.skillsByTurnId
  const canAppend = cached && unchangedBoundary && info.size > cached.size
  const state: SessionSkillInputCacheEntry = {
    size: info.size,
    boundary: await readSessionBoundary(sessionPath, info.size),
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    inode: info.ino,
    offset: canAppend ? cached.offset : 0,
    currentTurnId: canAppend ? cached.currentTurnId : '',
    skillsByTurnId: canAppend ? new Map([...cached.skillsByTurnId].map(([id, skills]) => [id, [...skills]])) : new Map(),
  }
  let pending = Buffer.alloc(0)
  let skippedBytes = 0
  if (state.offset < info.size) {
    for await (const chunk of createReadStream(sessionPath, { start: state.offset, end: info.size - 1 })) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        if (!skippedBytes) buildSessionSkillInputsByTurn(pending.subarray(0, newline).toString('utf8'), state)
        state.offset += skippedBytes + newline + 1
        skippedBytes = 0
        pending = pending.subarray(newline + 1)
      }
      // Embedded media/tool lines cannot be skill declarations. Bound the partial-line buffer.
      if (pending.length > 1024 * 1024) {
        skippedBytes += pending.length
        pending = Buffer.alloc(0)
      }
    }
  }
  // Do not advance beyond an incomplete last line; the next append rereads it.
  sessionSkillInputCache.set(sessionPath, state)
  while (sessionSkillInputCache.size > SESSION_SKILL_INPUT_CACHE_LIMIT) {
    const oldestKey = sessionSkillInputCache.keys().next().value
    if (!oldestKey) break
    sessionSkillInputCache.delete(oldestKey)
  }
  return state.skillsByTurnId
}

function mergeSessionSkillInputsIntoTurnsFromMap(
  turns: unknown[],
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>,
): unknown[] {
  const turnIds = new Set<string>()
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) turnIds.add(turnId)
  }
  if (turnIds.size === 0) return turns

  if (skillsByTurnId.size === 0) return turns

  let changed = false
  const nextTurns = turns.map(turn => {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    const skills = turnId ? skillsByTurnId.get(turnId) : undefined
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !skills || skills.length === 0 || !items) return turn

    let targetUserMessageIndex = -1
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const itemRecord = asRecord(items[index])
      if (itemRecord?.type === 'userMessage' && Array.isArray(itemRecord.content)) {
        targetUserMessageIndex = index
        break
      }
    }
    if (targetUserMessageIndex < 0) return turn

    let addedToMessage = false
    const nextItems = items.map((item, index) => {
      const itemRecord = asRecord(item)
      const content = Array.isArray(itemRecord?.content) ? itemRecord.content : null
      if (index !== targetUserMessageIndex || itemRecord?.type !== 'userMessage' || !content) return item

      const existingSkillPaths = new Set(
        content.flatMap(contentItem => {
          const contentRecord = asRecord(contentItem)
          const path = typeof contentRecord?.path === 'string' ? contentRecord.path.trim() : ''
          return contentRecord?.type === 'skill' && path ? [path] : []
        }),
      )
      const missingSkills = skills.filter(skill => !existingSkillPaths.has(skill.path))
      if (missingSkills.length === 0) return item

      addedToMessage = true
      changed = true
      return {
        ...itemRecord,
        content: [
          ...content,
          ...missingSkills.map(skill => ({ type: 'skill', name: skill.name, path: skill.path })),
        ],
      }
    })

    return addedToMessage ? { ...turnRecord, items: nextItems } : turn
  })

  return changed ? nextTurns : turns
}

export function mergeSessionSkillInputsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  return mergeSessionSkillInputsIntoTurnsFromMap(turns, buildSessionSkillInputsByTurn(sessionLogRaw))
}

export async function mergeSessionSkillInputsIntoThreadResult(result: unknown): Promise<unknown> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  const sessionPath = readNonEmptyString(thread?.path)
  if (!record || !thread || !turns || turns.length === 0 || !sessionPath || !isAbsolute(sessionPath)) {
    return result
  }

  try {
    const skillsByTurnId = await readCachedSessionSkillInputsByTurn(sessionPath)
    const mergedTurns = mergeSessionSkillInputsIntoTurnsFromMap(turns, skillsByTurnId)
    if (mergedTurns === turns) return result
    return {
      ...record,
      thread: {
        ...thread,
        turns: mergedTurns,
      },
    }
  } catch {
    return result
  }
}
