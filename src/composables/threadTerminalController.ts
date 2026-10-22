import { computed, ref } from 'vue'

type ThreadTerminalControllerOptions = {
  getSelectedThreadId: () => string
}

const THREAD_TERMINAL_OPEN_STORAGE_KEY = 'codex-web-local.thread-terminal-open.v1'

function loadThreadTerminalOpenMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TERMINAL_OPEN_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, boolean> = {}
    for (const [threadId, isOpen] of Object.entries(parsed as Record<string, unknown>)) {
      if (threadId && typeof isOpen === 'boolean') {
        normalizedMap[threadId] = isOpen
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTerminalOpenMap(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TERMINAL_OPEN_STORAGE_KEY, JSON.stringify(state))
}

export function createThreadTerminalController({ getSelectedThreadId }: ThreadTerminalControllerOptions) {
  const terminalOpenByThreadId = ref<Record<string, boolean>>(loadThreadTerminalOpenMap())
  const selectedThreadTerminalOpen = computed(() => {
    const threadId = getSelectedThreadId()
    return Boolean(threadId && terminalOpenByThreadId.value[threadId] === true)
  })

  function setThreadTerminalOpen(threadId: string, isOpen: boolean): void {
    if (!threadId) return
    const next = { ...terminalOpenByThreadId.value }
    if (isOpen) {
      next[threadId] = true
    } else {
      delete next[threadId]
    }
    terminalOpenByThreadId.value = next
    saveThreadTerminalOpenMap(next)
  }

  function toggleSelectedThreadTerminal(): void {
    const threadId = getSelectedThreadId()
    if (!threadId) return
    setThreadTerminalOpen(threadId, !selectedThreadTerminalOpen.value)
  }

  return { selectedThreadTerminalOpen, setThreadTerminalOpen, toggleSelectedThreadTerminal }
}
