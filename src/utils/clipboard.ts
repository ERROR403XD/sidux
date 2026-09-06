export function copyTextWithSelectionFallback(text: string): boolean {
  if (typeof document === 'undefined') return false

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  let inputSelection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null = null
  if (previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement) {
    if (previous.selectionStart !== null && previous.selectionEnd !== null) {
      inputSelection = { start: previous.selectionStart, end: previous.selectionEnd, direction: previous.selectionDirection || 'none' }
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  textarea.style.fontSize = '16px'
  document.body.appendChild(textarea)

  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
    try {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      if (inputSelection && (previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement)) {
        previous.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction)
      } else if (selection) {
        selection.removeAllRanges()
        for (const range of ranges) {
          if (range.commonAncestorContainer.isConnected) selection.addRange(range)
        }
      }
    } catch {
      // Focus/selection may have changed during the browser's copy event.
    }
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back for embedded browser contexts without clipboard permission.
    }
  }

  if (!copyTextWithSelectionFallback(text)) {
    throw new Error('Copy failed')
  }
}
