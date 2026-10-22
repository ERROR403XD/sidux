import { computed, type ComputedRef, type Ref } from 'vue'
import type { UiMessage } from '../types/codex'

export type ConversationCommandProjection = {
  activeCommandMessageId: ComputedRef<string>
  groupedCommandsByLatestId: ComputedRef<Record<string, UiMessage[]>>
  hiddenGroupedCommandIds: ComputedRef<Set<string>>
}

function isCommandMessage(message: UiMessage): boolean {
  return message.messageType === 'commandExecution' && !!message.commandExecution
}

export function useConversationCommandProjection(
  messages: Ref<UiMessage[]>,
  messageRenderKey: (message: UiMessage) => string,
): ConversationCommandProjection {
  const activeCommandMessageId = computed(() => {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index]
      if (message.messageType === 'commandExecution' && message.commandExecution?.status === 'inProgress') {
        return messageRenderKey(message)
      }
    }
    return ''
  })

  const groupedCommandsByLatestId = computed<Record<string, UiMessage[]>>(() => {
    const next: Record<string, UiMessage[]> = {}
    for (let index = 0; index < messages.value.length;) {
      const message = messages.value[index]
      if (!isCommandMessage(message)) {
        index += 1
        continue
      }

      const block: UiMessage[] = []
      while (index < messages.value.length && isCommandMessage(messages.value[index])) {
        block.push(messages.value[index])
        index += 1
      }

      if (block.length <= 1) continue
      const latest = block[block.length - 1]
      next[messageRenderKey(latest)] = block.slice(0, -1)
    }
    return next
  })

  const hiddenGroupedCommandIds = computed(() => {
    const next = new Set<string>()
    for (const commands of Object.values(groupedCommandsByLatestId.value)) {
      for (const command of commands) next.add(messageRenderKey(command))
    }
    return next
  })

  return {
    activeCommandMessageId,
    groupedCommandsByLatestId,
    hiddenGroupedCommandIds,
  }
}
