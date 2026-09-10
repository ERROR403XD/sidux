import { zhSourceEnglish } from './zhSourceEnglish'
import { zhSourceChinese } from './zhSourceChinese'

const chineseByEnglish = Object.fromEntries(
  Object.entries(zhSourceEnglish)
    .filter(([source]) => /\p{Script=Han}/u.test(source))
    .map(([source, english]) => [english, zhSourceChinese[source] ?? source]),
)

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
type TranslationPattern = { pattern: RegExp; keys: string[]; english: string; chinese: string; changesChinese: boolean }
const patternsByPrefix = new Map<string, TranslationPattern[]>()
for (const [source, english] of Object.entries(zhSourceEnglish)) {
  const keys = [...source.matchAll(/\{(v\d+)\}/g)].map(match => match[1])
  if (!keys.length) continue
  const pattern = new RegExp('^' + source.split(/\{v\d+\}/g).map(escapeRegex).join('([\\s\\S]*?)') + '$', 'u')
  const prefix = source.startsWith('{v') ? '' : source[0]
  const bucket = patternsByPrefix.get(prefix) ?? []
  const chinese = zhSourceChinese[source] ?? source
  bucket.push({ pattern, keys, english, chinese, changesChinese: chinese !== source })
  patternsByPrefix.set(prefix, bucket)
}

function translatePattern(message: string, language: 'english' | 'chinese'): string {
  if (!/\p{Script=Han}/u.test(message)) return message
  for (const bucket of [patternsByPrefix.get(message[0]), patternsByPrefix.get('')]) {
    for (const entry of bucket ?? []) {
      if (language === 'chinese' && !entry.changesChinese) continue
      const match = entry.pattern.exec(message)
      if (!match) continue
      const values = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]))
      return entry[language].replace(/\{(v\d+)\}/g, (placeholder, key: string) => values[key] ?? placeholder)
    }
  }
  return message
}

/** Used only at application-owned UI boundaries, never on conversation content. */
export function englishForSource(message: string, legacy: Readonly<Record<string, string>>): string {
  const exact = Object.hasOwn(zhSourceEnglish, message) ? zhSourceEnglish[message]
    : Object.hasOwn(legacy, message) ? legacy[message] : undefined
  return exact ?? translatePattern(message, 'english')
}

export function chineseForSource(message: string): string {
  if (Object.hasOwn(zhSourceChinese, message)) return zhSourceChinese[message]
  if (Object.hasOwn(chineseByEnglish, message)) return chineseByEnglish[message]
  if (Object.hasOwn(zhSourceEnglish, message)) return message
  return translatePattern(message, 'chinese')
}
