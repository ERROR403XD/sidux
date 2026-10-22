<template>
  <div
    class="message-text-flow"
    v-memo="[messageKey, message.text, cwd, highlightCacheVersion, markdownImageFailureVersion, copiedCodeBlockKey, copyFailureKey]"
  >
    <template v-for="(block, blockIndex) in getMessageBlocks(message)" :key="`block-${blockIndex}`">
      <p v-if="block.kind === 'paragraph'" class="message-text">
        <template v-for="(segment, segmentIndex) in getInlineSegments(block.value)" :key="`seg-${blockIndex}-${segmentIndex}`">
          <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
          <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
          <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
          <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
          <a
            v-else-if="segment.kind === 'file'"
            class="message-file-link"
            :href="toBrowseUrl(segment.path)"
            target="_blank"
            rel="noopener noreferrer"
            :title="segment.path"
          >
            {{ segment.displayPath }}
          </a>
          <a
            v-else-if="segment.kind === 'url'"
            class="message-file-link"
            :href="segment.href"
            target="_blank"
            rel="noopener noreferrer"
            :title="segment.href"
          >
            {{ segment.value }}
          </a>
          <code v-else class="message-inline-code">{{ segment.value }}</code>
        
</template>
              </p>
              <component
                :is="headingTag(block.level)"
                v-else-if="block.kind === 'heading'"
                class="message-heading"
                :class="headingClass(block.level)"
              >
                <template v-for="(segment, segmentIndex) in getInlineSegments(block.value)" :key="`heading-seg-${blockIndex}-${segmentIndex}`">
                  <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
                  <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
                  <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
                  <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
                  <a
                    v-else-if="segment.kind === 'file'"
                    class="message-file-link"
                    :href="toBrowseUrl(segment.path)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="segment.path"
                  >
                    {{ segment.displayPath }}
                  </a>
                  <a
                    v-else-if="segment.kind === 'url'"
                    class="message-file-link"
                    :href="segment.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="segment.href"
                  >
                    {{ segment.value }}
                  </a>
                  <code v-else class="message-inline-code">{{ segment.value }}</code>
                </template>
              </component>
              <blockquote v-else-if="block.kind === 'blockquote'" class="message-blockquote">
                <template v-for="(segment, segmentIndex) in getInlineSegments(block.value)" :key="`quote-seg-${blockIndex}-${segmentIndex}`">
                  <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
                  <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
                  <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
                  <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
                  <a
                    v-else-if="segment.kind === 'file'"
                    class="message-file-link"
                    :href="toBrowseUrl(segment.path)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="segment.path"
                  >
                    {{ segment.displayPath }}
                  </a>
                  <a
                    v-else-if="segment.kind === 'url'"
                    class="message-file-link"
                    :href="segment.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="segment.href"
                  >
                    {{ segment.value }}
                  </a>
                  <code v-else class="message-inline-code">{{ segment.value }}</code>
                </template>
              </blockquote>
              <ul v-else-if="block.kind === 'unorderedList'" class="message-list message-list-unordered">
                <li v-for="(item, itemIndex) in block.items" :key="`ul-${blockIndex}-${itemIndex}`" class="message-list-item">
                  <div class="message-list-item-content" v-html="renderListItemContentAsHtml(item)" />
                </li>
              </ul>
              <ul v-else-if="block.kind === 'taskList'" class="message-list message-task-list">
                <li v-for="(item, itemIndex) in block.items" :key="`task-${blockIndex}-${itemIndex}`" class="message-task-item">
                  <span class="message-task-checkbox" :data-checked="item.checked">{{ item.checked ? '☑' : '☐' }}</span>
                  <div class="message-list-item-text">
                    <template v-for="(segment, segmentIndex) in getInlineSegments(item.text)" :key="`task-seg-${blockIndex}-${itemIndex}-${segmentIndex}`">
                      <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
                      <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
                      <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
                      <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
                      <a
                        v-else-if="segment.kind === 'file'"
                        class="message-file-link"
                        :href="toBrowseUrl(segment.path)"
                        target="_blank"
                        rel="noopener noreferrer"
                        :title="segment.path"
                      >
                        {{ segment.displayPath }}
                      </a>
                      <a
                        v-else-if="segment.kind === 'url'"
                        class="message-file-link"
                        :href="segment.href"
                        target="_blank"
                        rel="noopener noreferrer"
                        :title="segment.href"
                      >
                        {{ segment.value }}
                      </a>
                      <code v-else class="message-inline-code">{{ segment.value }}</code>
                    </template>
                  </div>
                </li>
              </ul>
              <ol
                v-else-if="block.kind === 'orderedList'"
                class="message-list message-list-ordered"
                :start="block.start"
              >
                <li v-for="(item, itemIndex) in block.items" :key="`ol-${blockIndex}-${itemIndex}`" class="message-list-item">
                  <div class="message-list-item-content" v-html="renderListItemContentAsHtml(item)" />
                </li>
              </ol>
              <div v-else-if="block.kind === 'table'" class="message-table-wrap">
                <table class="message-table">
                  <thead>
                    <tr>
                      <th
                        v-for="(cell, cellIndex) in block.headers"
                        :key="`th-${blockIndex}-${cellIndex}`"
                        class="message-table-head-cell"
                        :style="{ textAlign: block.alignments[cellIndex] ?? 'left' }"
                      >
                        <template v-for="(segment, segmentIndex) in getInlineSegments(cell)" :key="`th-seg-${blockIndex}-${cellIndex}-${segmentIndex}`">
                          <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
                          <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
                          <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
                          <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
                          <a
                            v-else-if="segment.kind === 'file'"
                            class="message-file-link"
                            :href="toBrowseUrl(segment.path)"
                            target="_blank"
                            rel="noopener noreferrer"
                            :title="segment.path"
                          >
                            {{ segment.displayPath }}
                          </a>
                          <a
                            v-else-if="segment.kind === 'url'"
                            class="message-file-link"
                            :href="segment.href"
                            target="_blank"
                            rel="noopener noreferrer"
                            :title="segment.href"
                          >
                            {{ segment.value }}
                          </a>
                          <code v-else class="message-inline-code">{{ segment.value }}</code>
                        </template>
                      </th>
                    </tr>
                  </thead>
                  <tbody v-if="block.rows.length > 0">
                    <tr v-for="(row, rowIndex) in block.rows" :key="`tr-${blockIndex}-${rowIndex}`" class="message-table-body-row">
                      <td
                        v-for="(cell, cellIndex) in row"
                        :key="`td-${blockIndex}-${rowIndex}-${cellIndex}`"
                        class="message-table-cell"
                        :style="{ textAlign: block.alignments[cellIndex] ?? 'left' }"
                      >
                        <template v-for="(segment, segmentIndex) in getInlineSegments(cell)" :key="`td-seg-${blockIndex}-${rowIndex}-${cellIndex}-${segmentIndex}`">
                          <span v-if="segment.kind === 'text'">{{ segment.value }}</span>
                          <strong v-else-if="segment.kind === 'bold'" class="message-bold-text">{{ segment.value }}</strong>
                          <em v-else-if="segment.kind === 'italic'" class="message-italic-text">{{ segment.value }}</em>
                          <s v-else-if="segment.kind === 'strikethrough'" class="message-strikethrough-text">{{ segment.value }}</s>
                          <a
                            v-else-if="segment.kind === 'file'"
                            class="message-file-link"
                            :href="toBrowseUrl(segment.path)"
                            target="_blank"
                            rel="noopener noreferrer"
                            :title="segment.path"
                          >
                            {{ segment.displayPath }}
                          </a>
                          <a
                            v-else-if="segment.kind === 'url'"
                            class="message-file-link"
                            :href="segment.href"
                            target="_blank"
                            rel="noopener noreferrer"
                            :title="segment.href"
                          >
                            {{ segment.value }}
                          </a>
                          <code v-else class="message-inline-code">{{ segment.value }}</code>
                        </template>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else-if="block.kind === 'codeBlock'" class="message-code-block">
                <div class="message-code-heading">
                  <div class="message-code-language">{{ block.language }}</div>
                  <AppButton
                    class="message-code-copy"
                    :data-copied="copiedCodeBlockKey === `${messageKey}:${blockIndex}`"
                    @click="emit('copyCode', `${messageKey}:${blockIndex}`, block.value)"
                  >{{ copyFailureKey === `code:${messageKey}:${blockIndex}` ? t('Copy failed') : copiedCodeBlockKey === `${messageKey}:${blockIndex}` ? t('Copied') : t('Copy code') }}</AppButton>
                </div>
                <pre class="message-code-pre"><code class="hljs" v-html="renderCachedHighlightedCodeAsHtml(block.language, block.value)"></code></pre>
              </div>
              <hr v-else-if="block.kind === 'thematicBreak'" class="message-divider" />
              <p v-else-if="isMarkdownImageFailed(messageKey, blockIndex, block.url)" class="message-text">{{ block.markdown }}</p>
              <button
                v-else
                class="message-image-button"
                type="button"
                @click="emit('previewImage', block.url)"
              >
                <img
                  class="message-image-preview message-markdown-image"
                  :src="block.url"
                  :alt="block.alt || 'Embedded message image'"
                  loading="lazy"
                  @error="onMarkdownImageError(messageKey, blockIndex, block.url, $event)"
                />
              </button>
            </template>
          </div>
</template>

<script setup lang="ts">
import type { UiMessage } from '../../types/codex'
import type { useConversationRendering } from '../../composables/useConversationRendering'
import { headingTag, headingClass } from '../../composables/conversationMarkdown'
import { useUiLanguage } from '../../composables/useUiLanguage'
import AppButton from '../common/AppButton.vue'

type RichTextRendering = Pick<ReturnType<typeof useConversationRendering>, 'getMessageBlocks' | 'getInlineSegments' | 'toBrowseUrl' | 'renderListItemContentAsHtml' | 'renderCachedHighlightedCodeAsHtml' | 'isMarkdownImageFailed' | 'onMarkdownImageError'>
const props = defineProps<{
  message: UiMessage
  messageKey: string
  cwd: string
  rendering: RichTextRendering
  highlightCacheVersion: number
  markdownImageFailureVersion: number
  copiedCodeBlockKey: string
  copyFailureKey: string
}>()
const emit = defineEmits<{ copyCode: [key: string, content: string]; previewImage: [url: string] }>()
const { getMessageBlocks, getInlineSegments, toBrowseUrl, renderListItemContentAsHtml, renderCachedHighlightedCodeAsHtml, isMarkdownImageFailed, onMarkdownImageError } = props.rendering
const { t } = useUiLanguage()
</script>

<style scoped src="./conversationMessageContent.css"></style>
