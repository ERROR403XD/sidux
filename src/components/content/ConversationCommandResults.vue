<template>
  <div class="message-row" data-role="system">
    <div class="message-stack" data-role="system">
      <button
        v-if="getGroupedCommandsForLatest(message).length > 0"
        type="button"
        class="cmd-row cmd-row-group cmd-compact"
        :class="[commandStatusClass(message), { 'cmd-expanded': isCommandGroupExpanded(message) }]"
        @click="toggleCommandGroup(message)"
      >
        <span class="cmd-chevron" :class="{ 'cmd-chevron-open': isCommandGroupExpanded(message) }">▶</span>
        <span class="cmd-group-label">{{ commandGroupSummaryLabel(message) }}</span>
        <span class="cmd-status">{{ t(commandGroupSummaryStatus(message)) }}</span>
      </button>
      <div
        v-if="getGroupedCommandsForLatest(message).length > 0"
        class="cmd-group-wrap"
        :class="{ 'cmd-group-visible': isCommandGroupExpanded(message) }"
      >
        <div class="cmd-group-inner">
          <div
            v-for="cmd in getCommandBlockForLatest(message)"
            :key="`grouped-cmd-${renderKey(cmd)}`"
            class="worked-cmd-item"
          >
            <button
              type="button"
              class="cmd-row"
              :class="[
                commandStatusClass(cmd),
                {
                  'cmd-expanded': isCommandExpanded(cmd),
                  'cmd-compact': true,
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
      <template v-else>
        <button
          type="button"
          class="cmd-row"
          :class="[
            commandStatusClass(message),
            {
              'cmd-expanded': isCommandExpanded(message),
              'cmd-compact': isCommandCompact(message),
            },
          ]"
          @click="toggleCommandExpand(message)"
        >
          <span class="cmd-chevron" :class="{ 'cmd-chevron-open': isCommandExpanded(message) }">▶</span>
          <code class="cmd-label">{{ message.commandExecution?.command || '(command)' }}</code>
          <span class="cmd-status">{{ t(commandStatusLabel(message)) }}</span>
        </button>
        <div
          class="cmd-output-wrap"
          :class="{ 'cmd-output-visible': isCommandExpanded(message) }"
        >
          <div class="cmd-output-inner">
            <pre
              class="cmd-output"
              :class="{ 'cmd-output-condensed': isCommandOutputCondensed(message) }"
              v-text="message.commandExecution?.aggregatedOutput || '(no output)'"
            ></pre>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { UiMessage } from '../../types/codex'
import type { ConversationCommandResults } from '../../composables/useConversationMessagePresentation'
import { useUiLanguage } from '../../composables/useUiLanguage'

const props = defineProps<{ message: UiMessage; presentation: ConversationCommandResults }>()
const { renderKey, getGroupedCommandsForLatest, getCommandBlockForLatest, toggleCommandGroup, isCommandGroupExpanded, commandGroupSummaryLabel, commandGroupSummaryStatus, isCommandExpanded, isCommandCompact, isCommandOutputCondensed, toggleCommandExpand, commandStatusLabel, commandStatusClass } = props.presentation
const { t } = useUiLanguage()
</script>
