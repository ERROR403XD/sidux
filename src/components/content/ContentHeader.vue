<template>
  <header ref="headerRef" class="content-header">
    <div class="content-leading" :class="{ 'is-accent': accent }">
      <slot name="leading" />
    </div>
    <h1 v-if="title" class="content-title" :class="{ 'is-accent': accent }" :title="title">{{ title }}</h1>
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const headerRef = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null
let contentRoot: HTMLElement | null = null
let measureFrame = 0
let measuredHeight = -1
let measuredBottom = -1
onMounted(() => {
  const header = headerRef.value
  if (!header) return
  contentRoot = header.closest<HTMLElement>('.content-root')
  const measure = () => {
    measureFrame = 0
    const { height, bottom } = header.getBoundingClientRect()
    if (Math.abs(height - measuredHeight) < 0.5 && Math.abs(bottom - measuredBottom) < 0.5) return
    measuredHeight = height
    measuredBottom = bottom
    contentRoot?.style.setProperty('--content-header-height', `${height}px`)
    document.documentElement.style.setProperty('--operation-toast-top', `${bottom}px`)
  }
  measure()
  observer = new ResizeObserver(() => {
    if (!measureFrame) measureFrame = requestAnimationFrame(measure)
  })
  observer.observe(header)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(measureFrame)
  contentRoot?.style.removeProperty('--content-header-height')
  document.documentElement.style.removeProperty('--operation-toast-top')
})

defineProps<{
  title: string
  accent?: boolean
}>()
</script>

<style scoped>
@reference "tailwindcss";

.content-header {
  @apply relative z-[250] w-full min-w-0 min-h-12 sm:min-h-14 flex items-center gap-2 sm:gap-3 px-2 sm:px-3 pt-3 sm:pt-4 pb-2 bg-white;
}

.content-title {
  @apply m-0 min-w-0 max-w-[min(72ch,100%)] flex-1 truncate text-sm font-medium leading-6 text-slate-900 max-sm:text-xs;
}

.content-title.is-accent {
  @apply text-lg font-semibold leading-7 tracking-[-0.01em] text-zinc-950 sm:text-[1.4rem];
}

.content-actions {
  @apply ml-auto flex shrink-0 items-center justify-end gap-1;
}

.content-leading {
  @apply flex shrink-0 items-center gap-1;
}

.content-leading.is-accent {
  @apply gap-2;
}

:global(:root.dark) .content-title.is-accent {
  @apply text-zinc-100;
}
</style>
