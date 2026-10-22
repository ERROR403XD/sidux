<template>
  <div class="worked-separator-wrap" aria-live="polite">
    <button type="button" class="worked-separator" @click="toggleWorkedExpand(message)">
      <span class="worked-separator-line" aria-hidden="true" />
      <span class="worked-chevron" :class="{ 'worked-chevron-open': isWorkedExpanded(message) }">▶</span>
      <p class="worked-separator-text">{{ message.text }}</p>
      <span class="worked-separator-line" aria-hidden="true" />
    </button>
    <div v-if="isWorkedExpanded(message)" class="worked-details">
      <div
        v-for="cmd in commands"
        :key="`worked-cmd-${renderKey(cmd)}`"
        class="worked-cmd-item"
      >
        <button
          type="button"
          class="cmd-row"
          :class="[
            commandStatusClass(cmd),
            {
              'cmd-expanded': isCommandExpanded(cmd),
              'cmd-compact': isCommandCompact(cmd),
            },
          ]"
          @click="toggleCommandExpand(cmd)"
        >
          <span class="cmd-chevron" :class="{ 'cmd-chevron-open': isCommandExpanded(cmd) }">▶</span>
          <code class="cmd-label">{{ cmd.commandExecution?.command || '(command)' }}</code>
          <span class="cmd-status">{{ t(commandStatusLabel(cmd)) }}</span>
        </button>
        <div
          class="cmd-output-wrap"
          :class="{ 'cmd-output-visible': isCommandExpanded(cmd) }"
        >
          <div class="cmd-output-inner">
            <pre
              class="cmd-output"
              :class="{ 'cmd-output-condensed': isCommandOutputCondensed(cmd) }"
              v-text="cmd.commandExecution?.aggregatedOutput || '(no output)'"
            ></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { UiMessage } from '../../types/codex'
import type { ConversationCommandResults } from '../../composables/useConversationMessagePresentation'
import { useUiLanguage } from '../../composables/useUiLanguage'

const props = defineProps<{ message: UiMessage; commands: UiMessage[]; presentation: ConversationCommandResults }>()
const { renderKey, toggleWorkedExpand, isWorkedExpanded, isCommandExpanded, isCommandCompact, isCommandOutputCondensed, toggleCommandExpand, commandStatusLabel, commandStatusClass } = props.presentation
const { t } = useUiLanguage()
</script>
