import { onScopeDispose, readonly, ref, watch } from 'vue'
import type { UiMessage } from '../types/codex'
import { messageRenderKey } from '../messageIdentity'
import { CODE_LANGUAGE_ALIASES, escapeHtml } from './conversationRenderPrimitives'
import { createConversationInlineParser, headingClass, headingTag, parseMessageBlocks, toBrowseUrl as createBrowseUrl, type InlineSegment, type ListItem, type MessageBlock, type TableAlignment } from './conversationMarkdown'

type HighlightJsModule = (typeof import('highlight.js/lib/common'))['default']

type MessageBlockCacheEntry = {
  text: string
  cwd: string
  blocks: MessageBlock[]
}

type MarkdownHtmlCacheEntry = {
  text: string
  cwd: string
  highlightVersion: number
  html: string
}

export type ConversationRenderingOptions = {
  getThreadId: () => string
  getCwd: () => string
  getAccountRevision: () => number
  getMessages: () => readonly UiMessage[]
  loadHighlighter?: () => Promise<{ default: HighlightJsModule }>
}

export function useConversationRendering(options: ConversationRenderingOptions) {
  const highlightJsModule = ref<HighlightJsModule | null>(null)
  const highlightCacheVersion = ref(0)
  const markdownImageFailureVersion = ref(0)
  let highlightJsLoader: Promise<void> | null = null
  let renderingStopped = false
  const MESSAGE_BLOCK_CACHE_LIMIT = 300
  const INLINE_SEGMENT_CACHE_LIMIT = 1200
  const MARKDOWN_HTML_CACHE_LIMIT = 300
  const HIGHLIGHT_HTML_CACHE_LIMIT = 250
  const messageBlockCache = new Map<string, MessageBlockCacheEntry>()
  const inlineSegmentCache = new Map<string, InlineSegment[]>()
  const markdownHtmlCache = new Map<string, MarkdownHtmlCacheEntry>()
  const highlightHtmlCache = new Map<string, string>()
  const failedMarkdownImages = ref(new Map<string, { messageId: string; blockIndex: number; imageUrl: string }>())

  const { parseInlineSegmentsUncached } = createConversationInlineParser(() => typeof window === 'undefined' ? undefined : window.location)

  function renderKey(message: UiMessage): string { return messageRenderKey(message, options.getThreadId() || '') }

  function toBrowseUrl(pathValue: string): string { return createBrowseUrl(pathValue, options.getCwd()) }

  function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
    if (cache.has(key)) cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value as K | undefined
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
    return value
  }

  function ensureHighlightJsLoaded(): Promise<void> {
    if (renderingStopped || highlightJsModule.value) return Promise.resolve()
    if (!highlightJsLoader) {
      highlightJsLoader = (options.loadHighlighter ?? (() => import('highlight.js/lib/common')))()
        .then((module) => {
          if (renderingStopped) return
          highlightJsModule.value = module.default
          highlightHtmlCache.clear()
          markdownHtmlCache.clear()
          highlightCacheVersion.value += 1
        })
        .catch(() => {
          // A failed lazy import leaves escaped code visible and may be retried later.
        })
        .finally(() => {
          highlightJsLoader = null
        })
    }
    return highlightJsLoader
  }

  function getInlineSegments(text: string): InlineSegment[] {
    if (renderingStopped) return []
    const cached = inlineSegmentCache.get(text)
    if (cached) {
      inlineSegmentCache.delete(text)
      inlineSegmentCache.set(text, cached)
      return cached
    }
    return setBoundedCacheEntry(inlineSegmentCache, text, parseInlineSegmentsUncached(text), INLINE_SEGMENT_CACHE_LIMIT)
  }

  function getMessageBlocks(message: UiMessage): MessageBlock[] {
    if (renderingStopped) return []
    const cached = messageBlockCache.get(renderKey(message))
    if (cached && cached.text === message.text && cached.cwd === options.getCwd()) {
      messageBlockCache.delete(renderKey(message))
      messageBlockCache.set(renderKey(message), cached)
      return cached.blocks
    }
    clearMessageImageFailures(renderKey(message))
    const blocks = parseMessageBlocks(message.text)
    return setBoundedCacheEntry(
      messageBlockCache,
      renderKey(message),
      { text: message.text, cwd: options.getCwd(), blocks },
      MESSAGE_BLOCK_CACHE_LIMIT,
    ).blocks
  }

  function normalizeCodeLanguage(language: string): string {
    const token = language.trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
    if (!token) return ''
    return CODE_LANGUAGE_ALIASES[token] ?? token
  }

  function renderHighlightedCodeAsHtmlUncached(language: string, value: string): string {
    const normalizedLanguage = normalizeCodeLanguage(language)
    if (!normalizedLanguage) return escapeHtml(value)
    const highlighter = highlightJsModule.value
    if (!highlighter) return escapeHtml(value)

    try {
      if (highlighter.getLanguage(normalizedLanguage)) {
        return highlighter.highlight(value, {
          language: normalizedLanguage,
          ignoreIllegals: true,
        }).value
      }
    } catch {
      // Fall back to plain escaped code when highlighting fails.
    }

    return escapeHtml(value)
  }

  function renderCachedHighlightedCodeAsHtml(language: string, value: string): string {
    if (renderingStopped) return ''
    const cacheKey = `${highlightCacheVersion.value}\u0000${normalizeCodeLanguage(language)}\u0000${language}\u0000${value}`
    const cached = highlightHtmlCache.get(cacheKey)
    if (cached !== undefined) {
      highlightHtmlCache.delete(cacheKey)
      highlightHtmlCache.set(cacheKey, cached)
      return cached
    }
    return setBoundedCacheEntry(
      highlightHtmlCache,
      cacheKey,
      renderHighlightedCodeAsHtmlUncached(language, value),
      HIGHLIGHT_HTML_CACHE_LIMIT,
    )
  }

  function renderInlineSegmentsAsHtml(text: string): string {
    return getInlineSegments(text)
      .map((segment) => {
        if (segment.kind === 'text') {
          return escapeHtml(segment.value)
        }
        if (segment.kind === 'bold') {
          return `<strong class="message-bold-text">${escapeHtml(segment.value)}</strong>`
        }
        if (segment.kind === 'italic') {
          return `<em class="message-italic-text">${escapeHtml(segment.value)}</em>`
        }
        if (segment.kind === 'strikethrough') {
          return `<s class="message-strikethrough-text">${escapeHtml(segment.value)}</s>`
        }
        if (segment.kind === 'file') {
          return `<a class="message-file-link" href="${escapeHtml(toBrowseUrl(segment.path))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(segment.path)}">${escapeHtml(segment.displayPath)}</a>`
        }
        if (segment.kind === 'url') {
          return `<a class="message-file-link" href="${escapeHtml(segment.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(segment.href)}">${escapeHtml(segment.value)}</a>`
        }
        return `<code class="message-inline-code">${escapeHtml(segment.value)}</code>`
      })
      .join('')
  }

  function renderListItemParagraphsAsHtml(item: ListItem): string {
    return item.paragraphs
      .map((paragraph) => `<div class="message-list-item-text message-list-item-paragraph">${renderInlineSegmentsAsHtml(paragraph)}</div>`)
      .join('')
  }

  function renderListItemContentAsHtml(item: ListItem): string {
    const paragraphsHtml = renderListItemParagraphsAsHtml(item)
    const childrenHtml = item.children?.map((block) => renderMessageBlockAsHtml(block)).join('') ?? ''
    return paragraphsHtml + childrenHtml
  }

  function tableCellAlignmentStyle(alignment: TableAlignment): string {
    if (!alignment) return ''
    return ` style="text-align:${alignment}"`
  }

  function renderMessageBlockAsHtml(block: MessageBlock): string {
    if (block.kind === 'paragraph') {
      return `<p class="message-text">${renderInlineSegmentsAsHtml(block.value)}</p>`
    }
    if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, Math.trunc(block.level)))
      const tag = headingTag(level)
      const classes = `message-heading ${headingClass(level)}`
      return `<${tag} class="${classes}">${renderInlineSegmentsAsHtml(block.value)}</${tag}>`
    }
    if (block.kind === 'blockquote') {
      return `<blockquote class="message-blockquote">${renderInlineSegmentsAsHtml(block.value)}</blockquote>`
    }
    if (block.kind === 'unorderedList') {
      const items = block.items
        .map((item) => `<li class="message-list-item"><div class="message-list-item-content">${renderListItemContentAsHtml(item)}</div></li>`)
        .join('')
      return `<ul class="message-list message-list-unordered">${items}</ul>`
    }
    if (block.kind === 'taskList') {
      const items = block.items
        .map((item) => (
          `<li class="message-task-item">` +
          `<span class="message-task-checkbox" data-checked="${item.checked ? 'true' : 'false'}">${item.checked ? '☑' : '☐'}</span>` +
          `<div class="message-list-item-text">${renderInlineSegmentsAsHtml(item.text)}</div>` +
          `</li>`
        ))
        .join('')
      return `<ul class="message-list message-task-list">${items}</ul>`
    }
    if (block.kind === 'orderedList') {
      const items = block.items
        .map((item) => `<li class="message-list-item"><div class="message-list-item-content">${renderListItemContentAsHtml(item)}</div></li>`)
        .join('')
      return `<ol class="message-list message-list-ordered" start="${block.start}">${items}</ol>`
    }
    if (block.kind === 'table') {
      const headerCells = block.headers
        .map((cell, index) => `<th class="message-table-head-cell"${tableCellAlignmentStyle(block.alignments[index] ?? null)}>${renderInlineSegmentsAsHtml(cell)}</th>`)
        .join('')
      const rows = block.rows
        .map((row) => (
          `<tr class="message-table-body-row">` +
          row.map((cell, index) => `<td class="message-table-cell"${tableCellAlignmentStyle(block.alignments[index] ?? null)}>${renderInlineSegmentsAsHtml(cell)}</td>`).join('') +
          `</tr>`
        ))
        .join('')
      const body = rows ? `<tbody>${rows}</tbody>` : ''
      return `<div class="message-table-wrap"><table class="message-table"><thead><tr>${headerCells}</tr></thead>${body}</table></div>`
    }
    if (block.kind === 'codeBlock') {
      const language = block.language
        ? `<div class="message-code-language">${escapeHtml(block.language)}</div>`
        : ''
      return `<div class="message-code-block">${language}<pre class="message-code-pre"><code class="hljs">${renderCachedHighlightedCodeAsHtml(block.language, block.value)}</code></pre></div>`
    }
    if (block.kind === 'thematicBreak') {
      return '<hr class="message-divider">'
    }
    return `<img class="message-image-preview message-markdown-image" src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt || 'Embedded message image')}" loading="lazy">`
  }

  function renderMarkdownBlocksAsHtml(text: string): string {
    if (renderingStopped) return ''
    const cacheKey = `${options.getCwd()}\u0000${highlightCacheVersion.value}\u0000${text}`
    const cached = markdownHtmlCache.get(cacheKey)
    if (cached && cached.text === text && cached.cwd === options.getCwd() && cached.highlightVersion === highlightCacheVersion.value) {
      markdownHtmlCache.delete(cacheKey)
      markdownHtmlCache.set(cacheKey, cached)
      return cached.html
    }
    const html = parseMessageBlocks(text)
      .map((block) => renderMessageBlockAsHtml(block))
      .join('')
    return setBoundedCacheEntry(
      markdownHtmlCache,
      cacheKey,
      {
        text,
        cwd: options.getCwd(),
        highlightVersion: highlightCacheVersion.value,
        html,
      },
      MARKDOWN_HTML_CACHE_LIMIT,
    ).html
  }

  function clearRenderCaches(): void {
    messageBlockCache.clear()
    inlineSegmentCache.clear()
    markdownHtmlCache.clear()
    highlightHtmlCache.clear()
  }

  function resetRenderState(): void {
    clearRenderCaches()
    if (failedMarkdownImages.value.size > 0) {
      failedMarkdownImages.value = new Map()
      markdownImageFailureVersion.value += 1
    }
  }

  function markdownImageKey(messageId: string, blockIndex: number, imageUrl: string): string {
    return JSON.stringify([messageId, blockIndex, imageUrl])
  }

  function clearMessageImageFailures(messageId: string): void {
    const next = new Map(failedMarkdownImages.value)
    for (const [key, failure] of next) {
      if (failure.messageId === messageId) next.delete(key)
    }
    if (next.size === failedMarkdownImages.value.size) return
    failedMarkdownImages.value = next
    markdownImageFailureVersion.value += 1
  }

  function isMarkdownImageFailed(messageId: string, blockIndex: number, imageUrl: string): boolean {
    return !renderingStopped && failedMarkdownImages.value.has(markdownImageKey(messageId, blockIndex, imageUrl))
  }

  function onMarkdownImageError(messageId: string, blockIndex: number, imageUrl: string, event?: Event): void {
    if (renderingStopped) return
    if (event && !(event.currentTarget as HTMLElement | null)?.isConnected) return
    const message = options.getMessages().find((candidate) => renderKey(candidate) === messageId)
    if (!message) return
    const block = getMessageBlocks(message)[blockIndex]
    if (block?.kind !== 'image' || block.url !== imageUrl) return
    const key = markdownImageKey(messageId, blockIndex, imageUrl)
    if (failedMarkdownImages.value.has(key)) return
    const next = new Map(failedMarkdownImages.value)
    setBoundedCacheEntry(next, key, { messageId, blockIndex, imageUrl }, MESSAGE_BLOCK_CACHE_LIMIT)
    failedMarkdownImages.value = next
    markdownImageFailureVersion.value += 1
  }

  const stopIdentityWatch = watch(
    [() => options.getThreadId(), () => options.getCwd(), () => options.getAccountRevision()],
    resetRenderState,
    { flush: 'sync' },
  )

  const stopCodeWatch = watch(
    () => options.getMessages().some((message) => message.text.includes('```')),
    (hasCodeBlocks) => {
      if (!hasCodeBlocks || highlightJsModule.value) return
      void ensureHighlightJsLoaded()
    },
    { immediate: true },
  )

  function stop(): void {
    if (renderingStopped) return
    renderingStopped = true
    stopIdentityWatch()
    stopCodeWatch()
    highlightJsLoader = null
    highlightJsModule.value = null
    resetRenderState()
  }

  onScopeDispose(stop)

  return {
    getMessageBlocks, getInlineSegments, toBrowseUrl, renderMarkdownBlocksAsHtml,
    renderListItemContentAsHtml, renderCachedHighlightedCodeAsHtml,
    isMarkdownImageFailed, onMarkdownImageError, ensureHighlightJsLoaded,
    highlightCacheVersion: readonly(highlightCacheVersion),
    markdownImageFailureVersion: readonly(markdownImageFailureVersion),
    stop,
  }
}
