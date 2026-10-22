export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const normalizedValue = Math.max(0, Math.trunc(value))
  return new Intl.NumberFormat('en-US', {
    notation: normalizedValue >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: normalizedValue >= 100000 ? 0 : 1,
  }).format(normalizedValue)
}
