import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/** Keep the displayed draft owned by its original context until a batched switch completes. */
export function useComposerDraftPersistence<T>(options: {
  context: Readonly<Ref<string>>
  payload: () => T
  load: (context: string) => T | null
  restore: (payload: T | null) => void
  save: (context: string, payload: T) => boolean
  recovery?: Map<string, string>
}) {
  let owner = ''
  let savedPayload = ''
  const unsaved = options.recovery ?? new Map<string, string>()

  const flush = () => {
    if (!owner) return
    const payload = options.payload()
    const serialized = JSON.stringify(payload)
    // Leaving an untouched view must not overwrite a newer draft from another tab.
    if (serialized === savedPayload && !unsaved.has(owner)) return
    if (options.save(owner, payload)) {
      savedPayload = serialized
      unsaved.delete(owner)
    } else {
      unsaved.set(owner, serialized)
    }
  }

  watch(options.context, context => {
    const next = context.trim()
    if (next === owner) return
    flush()
    owner = ''
    const recovered = unsaved.get(next)
    options.restore(recovered === undefined ? options.load(next) : JSON.parse(recovered) as T)
    owner = next
    savedPayload = JSON.stringify(options.payload())
  }, { immediate: true })

  watch(options.payload, flush, { deep: true })

  onMounted(() => {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
  })
  onBeforeUnmount(() => {
    flush()
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
  })

  return {
    flush,
    saveCurrent(): void {
      savedPayload = ''
      flush()
    },
    // Acknowledgement already handled persistent storage by revision. Do not write an empty
    // view over a newer revision from another tab when the payload watcher next runs.
    acceptCurrent(): void {
      unsaved.delete(owner)
      savedPayload = JSON.stringify(options.payload())
    },
  }
}
