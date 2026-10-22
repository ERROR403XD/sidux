export type ThreadTurnStartInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

const MAX_FINISHED_TURNS = 2000

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId])
}

export function createThreadTurnLifecycleState() {
  const finishedTurns = new Set<string>()
  const pendingStartsByTurnId = new Map<string, ThreadTurnStartInfo>()

  return {
    hasFinished: (threadId: string, turnId: string): boolean => {
      return finishedTurns.has(turnKey(threadId, turnId))
    },
    rememberFinished: (threadId: string, turnId: string): void => {
      finishedTurns.add(turnKey(threadId, turnId))
      if (finishedTurns.size > MAX_FINISHED_TURNS) {
        finishedTurns.delete(finishedTurns.values().next().value!)
      }
    },
    rememberStarted: (turn: ThreadTurnStartInfo): boolean => {
      if (finishedTurns.has(turnKey(turn.threadId, turn.turnId))) return false
      pendingStartsByTurnId.set(turn.turnId, turn)
      return true
    },
    takeStarted: (turnId: string): ThreadTurnStartInfo | null => {
      const turn = pendingStartsByTurnId.get(turnId) ?? null
      if (turn) pendingStartsByTurnId.delete(turnId)
      return turn
    },
    clear: (): void => {
      finishedTurns.clear()
      pendingStartsByTurnId.clear()
    },
  }
}
