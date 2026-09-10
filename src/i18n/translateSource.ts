import { zhSourceEnglish } from './zhSourceEnglish'

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patternsByPrefix = new Map<string, Array<{ pattern: RegExp; keys: string[]; english: string }>>()
for (const [source, english] of Object.entries(zhSourceEnglish)) {
  const keys = [...source.matchAll(/\{(v\d+)\}/g)].map(match => match[1])
  if (!keys.length) continue
  const pattern = new RegExp('^' + source.split(/\{v\d+\}/g).map(escapeRegex).join('([\\s\\S]*?)') + '$', 'u')
  const prefix = source.startsWith('{v') ? '' : source[0]
  const bucket = patternsByPrefix.get(prefix) ?? []
  bucket.push({ pattern, keys, english })
  patternsByPrefix.set(prefix, bucket)
}

/** Used only at application-owned UI boundaries, never on conversation content. */
export function englishForSource(message: string, legacy: Readonly<Record<string, string>>): string {
  const exact = Object.hasOwn(zhSourceEnglish, message) ? zhSourceEnglish[message]
    : Object.hasOwn(legacy, message) ? legacy[message] : undefined
  if (exact !== undefined) return exact
  if (!/\p{Script=Han}/u.test(message)) return message
  for (const bucket of [patternsByPrefix.get(message[0]), patternsByPrefix.get('')]) {
    for (const entry of bucket ?? []) {
      const match = entry.pattern.exec(message)
      if (!match) continue
      const values = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]))
      return entry.english.replace(/\{(v\d+)\}/g, (placeholder, key: string) => values[key] ?? placeholder)
    }
  }
  return message
}
