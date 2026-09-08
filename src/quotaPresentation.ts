export function quotaRemaining(used: number): number {
  return Math.round(100 - Math.max(0, Math.min(100, Number.isFinite(used) ? used : 0)))
}

export function quotaColor(used: number): string {
  const colors = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444']
  return colors[Math.min(4, Math.max(0, Math.floor((Number.isFinite(used) ? used : 0) / 20)))]!
}
