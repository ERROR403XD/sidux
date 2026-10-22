type ThreadHistoryRequestStateOptions = {
  getAccountRevision: () => number
  getLifecycleRevision?: () => number
}

type ThreadHistoryRequest = {
  accountRevision: number
  lifecycleRevision: number
  promise: Promise<void>
}

export function createThreadHistoryRequestState({
  getAccountRevision,
  getLifecycleRevision = () => 0,
}: ThreadHistoryRequestStateOptions) {
  const requestByThreadId = new Map<string, ThreadHistoryRequest>()

  async function loadHistory(threadId: string, run: () => Promise<void>): Promise<void> {
    const joinedRevision = getAccountRevision()
    const lifecycleRevision = getLifecycleRevision()
    const existingRequest = requestByThreadId.get(threadId)
    if (existingRequest?.accountRevision === joinedRevision && existingRequest.lifecycleRevision === lifecycleRevision) {
      try {
        await existingRequest.promise
      } catch (cause) {
        if (lifecycleRevision !== getLifecycleRevision()) return
        if (joinedRevision === getAccountRevision()) throw cause
        return loadHistory(threadId, run)
      }
      if (lifecycleRevision !== getLifecycleRevision()) return
      if (joinedRevision !== getAccountRevision()) return loadHistory(threadId, run)
      return
    }

    const accountRevision = getAccountRevision()
    let request: ThreadHistoryRequest
    const promise = run().finally(() => {
      if (requestByThreadId.get(threadId) === request) requestByThreadId.delete(threadId)
    })
    request = { accountRevision, lifecycleRevision, promise }
    requestByThreadId.set(threadId, request)
    await promise
  }

  return {
    loadHistory,
    get threadIds() {
      return [...requestByThreadId.keys()]
    },
  }
}
