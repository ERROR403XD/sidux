export function normalizeTimeInput(value: string): string {
  const text = value.trim().replace(/[：﹕]/g, ':').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10))
  const match = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(text)
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]!.padStart(2, '0')}` : text
}
export function isValidTimeInput(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}
