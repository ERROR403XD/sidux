import { readonly, ref } from 'vue'

export type RuntimeCapabilities = {
  cliVersion: string
  schemaHash: string
  experimental: boolean
  methods: string[]
  appVersion: string
  generatedAt: string
  features?: { historyPaging: boolean }
}

const capabilities = ref<RuntimeCapabilities | null>(null)
const error = ref('')
const loading = ref(false)

export function useRuntimeCapabilities() {
  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      const response = await fetch('/codex-api/meta/capabilities')
      if (!response.ok) throw new Error('能力检测暂时不可用')
      capabilities.value = (await response.json()).data
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '能力检测失败'
    } finally {
      loading.value = false
    }
  }

  return {
    runtimeCapabilities: readonly(capabilities),
    runtimeCapabilitiesError: readonly(error),
    runtimeCapabilitiesLoading: readonly(loading),
    loadRuntimeCapabilities: load,
  }
}
