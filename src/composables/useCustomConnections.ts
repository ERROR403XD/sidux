import { computed, ref } from 'vue'
import type { CustomConnectionSnapshot } from '../customConnections'
const state = ref<CustomConnectionSnapshot>({ activeId: null, connections: [] })
let flight: Promise<void> | undefined
export async function customConnectionRequest<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/codex-api/custom-connections${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '连接配置无效')
  return result.data
}
export function useCustomConnections() {
  async function load(): Promise<void> {
    if (!flight) flight = customConnectionRequest<CustomConnectionSnapshot>().then(value => { state.value = value }).finally(() => { flight = undefined })
    return flight
  }
  return { state, active: computed(() => state.value.connections.find(row => row.storageId === state.value.activeId)), load }
}
