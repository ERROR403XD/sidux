import type { UiMessage } from './types/codex'

export function orderedTurnIds(lookup: Record<string, number>): string[] {
  return Object.entries(lookup).sort((a, b) => a[1] - b[1]).map(([id]) => id)
}

/** Indices describe the loaded contiguous interval, including turns with no display items. */
export function mergeTurnOrder(previous: Record<string, number>, incoming: Record<string, number>, prepend = false): Record<string, number> {
  const first = orderedTurnIds(prepend ? incoming : previous)
  const second = orderedTurnIds(prepend ? previous : incoming)
  const merged = [...first]
  const present = new Set(merged)
  for (let index = 0; index < second.length; index += 1) {
    const id = second[index]
    if (present.has(id)) continue
    const anchor = second.slice(index + 1).find(next => present.has(next))
    if (anchor) merged.splice(merged.indexOf(anchor), 0, id)
    else merged.push(id)
    present.add(id)
  }
  return Object.fromEntries(merged.map((id, index) => [id, index]))
}

export function bindMessageTurnOrder(messages: UiMessage[], lookup: Record<string, number>): UiMessage[] {
  return messages.map(message => {
    const index = message.turnId ? lookup[message.turnId] : undefined
    return index === undefined || message.turnIndex === index ? message : { ...message, turnIndex: index }
  }).sort((a, b) => (a.turnId ? lookup[a.turnId] ?? Infinity : Infinity) - (b.turnId ? lookup[b.turnId] ?? Infinity : Infinity))
}
