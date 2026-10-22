import { ref } from 'vue'
import { asRecord, omitKey, readString } from './threadNotificationValues'

export type ThreadCompletionControllerOptions = {
  getSelectedThreadId: () => string
  isThreadVisible?: (threadId: string) => boolean
  onChanged: () => void
}

export function createThreadCompletionController({ getSelectedThreadId, isThreadVisible, onChanged }: ThreadCompletionControllerOptions) {
  const eventUnreadByThreadId = ref<Record<string, string>>({})
  const backgroundByThreadId = ref<Record<string, boolean>>({})
  let kindChangesDuringLoad: Record<string, boolean> | null = null
  let completionChangesDuringLoad: Record<string, string | null> | null = null
  let completionLoad: { promise: Promise<void>; isCurrent: () => boolean } | null = null
  const inFlightCompletionAcknowledgements = new Map<string, { token: string; generation: number }>()
  const acknowledgedCompletionTokens = new Set<string>()
  let completionAcknowledgementGeneration = 0

  let completionReadLifecycleRevision = 0
  let completionStopped = false

  function loadCompletionList(): Promise<void> {
    if (completionLoad?.isCurrent()) return completionLoad.promise
    const lifecycleRevision = completionReadLifecycleRevision
    const changes: Record<string, string | null> = Object.create(null)
    const request = {
      promise: Promise.resolve(),
      isCurrent: (): boolean => lifecycleRevision === completionReadLifecycleRevision && completionLoad === request,
    }
    completionChangesDuringLoad = changes
    const kindChanges: Record<string, boolean> = Object.create(null)
    kindChangesDuringLoad = kindChanges
    completionLoad = request
    request.promise = fetch('/codex-api/thread-completions').then(async response => {
      if (!request.isCurrent()) return
      if (!response.ok) throw new Error('Failed to load completion list')
      const { data, kinds } = await response.json()
      if (!request.isCurrent()) return
      const entries: Record<string, string> = Object.create(null)
      const background: Record<string, boolean> = Object.create(null)
      for (const [id, token] of Object.entries(data ?? {})) {
        if (typeof token === 'string') entries[id] = token
        if (typeof token === 'string' && kinds?.[id] === 'background') background[id] = true
      }
      for (const [id, token] of Object.entries(changes)) {
        if (token) entries[id] = token
        else delete entries[id]
      }
      for (const [id, value] of Object.entries(kindChanges)) {
        if (value && entries[id]) background[id] = true
        else delete background[id]
      }
      eventUnreadByThreadId.value = entries
      backgroundByThreadId.value = background
      onChanged()
    }).catch(() => {}).finally(() => {
      if (completionLoad === request) {
        completionChangesDuringLoad = null
        kindChangesDuringLoad = null
        completionLoad = null
      }
    })
    return request.promise
  }

  function resetCompletionAcknowledgements(): void {
    completionAcknowledgementGeneration += 1
    inFlightCompletionAcknowledgements.clear()
    acknowledgedCompletionTokens.clear()
  }

  function markThreadAsRead(threadId: string): void {
    const token = eventUnreadByThreadId.value[threadId]
    const acknowledgementKey = `${threadId}\u0000${token}`
    if (!token || inFlightCompletionAcknowledgements.get(threadId)?.token === token || acknowledgedCompletionTokens.has(acknowledgementKey)) return
    const request = { token, generation: completionAcknowledgementGeneration }
    inFlightCompletionAcknowledgements.set(threadId, request)
    void fetch('/codex-api/thread-completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, token }),
    }).then(response => {
      if (!response.ok || request.generation !== completionAcknowledgementGeneration) return
      acknowledgedCompletionTokens.add(acknowledgementKey)
      if (acknowledgedCompletionTokens.size > 500) {
        acknowledgedCompletionTokens.delete(acknowledgedCompletionTokens.values().next().value!)
      }
      if (eventUnreadByThreadId.value[threadId] === token) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
        backgroundByThreadId.value = omitKey(backgroundByThreadId.value, threadId)
        if (completionChangesDuringLoad) completionChangesDuringLoad[threadId] = null
        if (kindChangesDuringLoad) kindChangesDuringLoad[threadId] = false
        onChanged()
      }
    }).catch(() => {}).finally(() => {
      if (inFlightCompletionAcknowledgements.get(threadId) === request) inFlightCompletionAcknowledgements.delete(threadId)
    })
  }

  function handleCompletionChange(input: unknown): void {
    const params = asRecord(input)
    const threadId = readString(params?.threadId)
    const token = typeof params?.token === 'string' ? params.token : null
    if (threadId) {
      if (completionChangesDuringLoad) completionChangesDuringLoad[threadId] = token
      if (token) eventUnreadByThreadId.value = { ...eventUnreadByThreadId.value, [threadId]: token }
      else eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
      const background = Boolean(token && params?.kind === 'background')
      if (kindChangesDuringLoad) kindChangesDuringLoad[threadId] = background
      backgroundByThreadId.value = background
        ? { ...backgroundByThreadId.value, [threadId]: true }
        : omitKey(backgroundByThreadId.value, threadId)
      onChanged()
      if (token && getSelectedThreadId() === threadId
        && typeof document !== 'undefined' && document.visibilityState === 'visible'
        && isThreadVisible?.(threadId)) {
        markThreadAsRead(threadId)
      }
    }
  }

  function stop(): void {
    completionStopped = true
    completionReadLifecycleRevision++
    resetCompletionAcknowledgements()
    completionLoad = null
    completionChangesDuringLoad = null
    kindChangesDuringLoad = null
    eventUnreadByThreadId.value = {}
    backgroundByThreadId.value = {}
  }

  return {
    markProjectAsRead: async (projectName: string) => {
      if (completionStopped) return
      const response = await fetch('/codex-api/thread-completions/project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectName }),
      })
      if (!response.ok) throw new Error('项目已读状态保存失败，请重试。')
      if (!completionStopped) await loadCompletionList()
    },
    getUnreadToken: (threadId: string) => backgroundByThreadId.value[threadId] ? undefined : eventUnreadByThreadId.value[threadId],
    isBackgroundCompleted: (threadId: string) => Boolean(backgroundByThreadId.value[threadId] && eventUnreadByThreadId.value[threadId]),
    loadCompletionList: () => completionStopped ? Promise.resolve() : loadCompletionList(),
    markThreadAsRead: (threadId: string) => {
      if (completionStopped) return
      markThreadAsRead(threadId)
    },
    handleCompletionChange: (params: unknown) => {
      if (completionStopped) return
      handleCompletionChange(params)
    },
    resetCompletionAcknowledgements,
    start: () => { completionStopped = false },
    stop,
  }
}
