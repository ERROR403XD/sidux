import { onMounted, onUnmounted, readonly, ref } from 'vue'

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let readers = 0

// All visible account cards share one local clock; no quota requests are made.
export function useQuotaClock() {
  onMounted(() => {
    readers += 1
    now.value = Date.now()
    if (timer === null) timer = setInterval(() => { now.value = Date.now() }, 60_000)
  })
  onUnmounted(() => {
    readers -= 1
    if (readers === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  })
  return readonly(now)
}
