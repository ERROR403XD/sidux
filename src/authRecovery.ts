export type AuthRecoveryState = {
  threadId: string
  turnId: string
  provider: string
  message: string
  phase: 'started' | 'completed'
}

export function readAuthRecovery(value: unknown): AuthRecoveryState | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.threadId !== 'string' || !row.threadId || typeof row.turnId !== 'string' || !row.turnId) return null
  if (row.phase !== 'started' && row.phase !== 'completed') return null
  return {
    threadId: row.threadId,
    turnId: row.turnId,
    provider: typeof row.provider === 'string' ? row.provider.slice(0, 200) : '',
    message: typeof row.message === 'string' ? row.message.slice(0, 2000) : '',
    phase: row.phase,
  }
}

export function authRecoveryFromNotification(method: string, params: unknown): AuthRecoveryState | null {
  if (method !== 'modelProvider/authRecoveryStarted' && method !== 'modelProvider/authRecoveryCompleted') return null
  return readAuthRecovery({ ...(params as object), phase: method.endsWith('Started') ? 'started' : 'completed' })
}

export class AuthRecoveryRegistry {
  private states = new Map<string, AuthRecoveryState>()

  observe(method: string, params: unknown): void {
    const state = authRecoveryFromNotification(method, params)
    if (state) {
      this.states.delete(state.threadId)
      this.states.set(state.threadId, state)
      if (this.states.size > 100) this.states.delete(this.states.keys().next().value!)
      return
    }
    if (method === 'turn/completed' || method === 'turn/cancelled' || method === 'turn/started') {
      const row = params as { threadId?: string; turn?: { id?: string } } | null
      if (!row?.threadId) return
      const current = this.states.get(row.threadId)
      if (method === 'turn/started' || !row.turn?.id || current?.turnId === row.turn.id) this.states.delete(row.threadId)
    }
  }

  snapshot(): AuthRecoveryState[] { return [...this.states.values()] }
  clear(): void { this.states.clear() }
}
