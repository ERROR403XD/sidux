import { computed, ref, type Ref } from 'vue'
import { commandKeyAction, filterComposerCommands, findSlashToken, type ComposerCommand, type SlashToken } from '../components/content/composerCommands'

export function useComposerCommandPicker(commands: Ref<ComposerCommand[]>, apply: (command: ComposerCommand, token: SlashToken) => void) {
  const token = ref<SlashToken | null>(null)
  const visible = ref(false)
  const selectedIndex = ref(-1)
  let suppressedStart: number | null = null
  let activeCommandInput = false
  const results = computed(() => filterComposerCommands(commands.value, token.value?.query ?? ''))
  function update(text: string, cursor: number, end = cursor, paste = false, allowOpening = true) {
    const next = findSlashToken(text, cursor, end)
    if (!next) activeCommandInput = false
    else if (allowOpening && !paste) activeCommandInput = true
    if (!next || next.start !== token.value?.start) suppressedStart = null
    if (paste && next) suppressedStart = next.start
    if (next?.query !== token.value?.query || next?.start !== token.value?.start) selectedIndex.value = -1
    token.value = next
    visible.value = Boolean(next && activeCommandInput && suppressedStart !== next.start)
  }
  function reset() { token.value = null; suppressedStart = null; activeCommandInput = false; visible.value = false; selectedIndex.value = -1 }
  function dismiss() { suppressedStart = token.value?.start ?? null; activeCommandInput = false; visible.value = false; selectedIndex.value = -1 }
  function choose(command: ComposerCommand) {
    const current = token.value
    if (!current || !visible.value) return
    dismiss(); apply(command, current)
  }
  function keydown(event: KeyboardEvent) {
    if (!visible.value) return false
    const action = commandKeyAction(event, results.value.length, selectedIndex.value)
    if (!action) return false
    event.preventDefault()
    if (action === 'dismiss') dismiss()
    else if (action === 'select') { const selected = results.value[selectedIndex.value]; if (selected) choose(selected) }
    else selectedIndex.value = selectedIndex.value < 0
      ? action === 'next' ? 0 : results.value.length - 1
      : (selectedIndex.value + (action === 'next' ? 1 : -1) + results.value.length) % results.value.length
    return true
  }
  return { token, visible, selectedIndex, results, update, dismiss, reset, choose, keydown }
}
