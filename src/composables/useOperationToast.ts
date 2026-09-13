import { readonly, ref } from 'vue'

export type OperationToastKind = 'success' | 'error' | 'warning' | 'info'
export type OperationToast = { id: number; message: string; kind: OperationToastKind; scope?: string; remaining: number; started: number; duration: number; paused: boolean }
const items = ref<OperationToast[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 0
export const operationToasts = readonly(items)
export function dismissOperationToast(id: number): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
  items.value = items.value.filter(item => item.id !== id)
}
export function pauseOperationToast(id: number): void {
  const item = items.value.find(item => item.id === id)
  if (!item || !timers.has(id)) return
  clearTimeout(timers.get(id))
  timers.delete(id)
  item.paused = true
  item.remaining = Math.max(0, item.remaining - (Date.now() - item.started))
}
export function resumeOperationToast(id: number): void {
  const item = items.value.find(item => item.id === id)
  if (!item || timers.has(id)) return
  item.paused = false
  item.started = Date.now()
  timers.set(id, setTimeout(() => dismissOperationToast(id), item.remaining))
}
export function clearOperationToasts(scope?: string): void {
  for (const item of [...items.value]) if (scope === undefined || item.scope === scope) dismissOperationToast(item.id)
}
export function notifyOperation(message: string, kind: OperationToast['kind'] = 'error', scope?: string): void {
  if (!message.trim()) return
  const duplicate = items.value.find(item => item.message === message && item.kind === kind && item.scope === scope)
  if (duplicate) dismissOperationToast(duplicate.id)
  while (items.value.length >= 3) dismissOperationToast(items.value[0]!.id)
  const id = ++nextId
  const duration = kind === 'success' || kind === 'info' ? 3000 : 6000
  items.value.push({ id, message, kind, scope, remaining: duration, duration, paused: false, started: Date.now() })
  resumeOperationToast(id)
}
