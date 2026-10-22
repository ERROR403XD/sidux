export type ThreadListRequestContext = {
  accountRevision: number
  statusRevisions: Map<string, number>
  force: boolean
}

type ThreadListRequestStateOptions<T> = {
  getAccountRevision: () => number
  getHasLoaded: () => boolean
  setLoading: (loading: boolean) => void
  beginRequest: (force: boolean) => ThreadListRequestContext
  load: (context: ThreadListRequestContext) => Promise<T>
  apply: (result: T, context: ThreadListRequestContext) => Promise<void> | void
}

type ThreadListRequest<T> = {
  context: ThreadListRequestContext
  promise: Promise<T>
  completion: Promise<void>
}

export function createThreadListRequestState<T>({
  getAccountRevision,
  getHasLoaded,
  setLoading,
  beginRequest,
  load,
  apply,
}: ThreadListRequestStateOptions<T>) {
  let currentRequest: ThreadListRequest<T> | null = null
  let lifecycleGeneration = 0

  function isCurrentContext(context: ThreadListRequestContext): boolean {
    return currentRequest?.context === context && context.accountRevision === getAccountRevision()
  }

  function runRequest(request: ThreadListRequest<T>): Promise<void> {
    return request.promise.then(
      async result => {
        if (request !== currentRequest || request.context.accountRevision !== getAccountRevision()) return
        await apply(result, request.context)
      },
      async cause => {
        if (request !== currentRequest || request.context.accountRevision !== getAccountRevision()) return
        throw cause
      },
    ).finally(() => {
      if (request === currentRequest) {
        currentRequest = null
        setLoading(false)
      }
    })
  }

  async function loadList(options: { force?: boolean } = {}): Promise<void> {
    const joinedRevision = getAccountRevision()
    const joinedLifecycle = lifecycleGeneration
    if (currentRequest && currentRequest.context.accountRevision === joinedRevision) {
      try {
        await currentRequest.completion
      } catch (cause) {
        if (joinedLifecycle !== lifecycleGeneration) return
        if (joinedRevision === getAccountRevision()) throw cause
        return loadList(options)
      }
      if (joinedLifecycle !== lifecycleGeneration) return
      if (joinedRevision !== getAccountRevision()) return loadList(options)
      return
    }
    if (!getHasLoaded()) setLoading(true)
    const context = beginRequest(options.force === true)
    const promise = load(context)
    const request: ThreadListRequest<T> = { context, promise, completion: Promise.resolve() }
    currentRequest = request
    request.completion = runRequest(request)
    await request.completion
  }

  function resetForAccountChange(): void {
    currentRequest = null
    setLoading(false)
  }

  return {
    loadList,
    resetForAccountChange,
    isCurrentContext,
    stop: () => {
      lifecycleGeneration++
      resetForAccountChange()
    },
    get isLoading() {
      return currentRequest !== null
    },
  }
}
