import { computed, onScopeDispose, ref } from 'vue'

/** Success feedback belongs to the current action, not the next visit. */
export function useTransientNotice(durationMs = 3500) {
  const message = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  onScopeDispose(clearTimer)
  return computed({
    get: () => message.value,
    set: (value: string) => {
      clearTimer()
      message.value = value
      if (value) timer = setTimeout(() => {
        message.value = ''
        timer = undefined
      }, durationMs)
    },
  })
}
