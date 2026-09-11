import type { CSSProperties } from 'vue'

type PositionInput = {
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>
  avoidAnchorOverlap?: boolean
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  direction: 'up' | 'down'
  align: 'start' | 'end'
}

// Fixed coordinates are viewport-relative; AppPopover always teleports to body.
export function positionPopover(input: PositionInput): CSSProperties {
  const padding = 8
  const gap = 8
  const width = Math.max(0, Math.min(input.width, input.viewportWidth - padding * 2))
  const availableHeight = input.avoidAnchorOverlap
    ? input.direction === 'up'
      ? input.anchor.top - gap - padding
      : input.viewportHeight - input.anchor.bottom - gap - padding
    : input.viewportHeight - padding * 2
  const maxHeight = Math.max(0, Math.min(availableHeight, input.viewportHeight - padding * 2))
  const height = Math.min(input.height, maxHeight)
  const desiredLeft = input.align === 'end' ? input.anchor.right - width : input.anchor.left
  const desiredTop = input.direction === 'up'
    ? input.anchor.top - height - gap
    : input.anchor.bottom + gap
  const left = Math.max(padding, Math.min(desiredLeft, input.viewportWidth - width - padding))
  const top = Math.max(padding, Math.min(desiredTop, input.viewportHeight - height - padding))
  return {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    '--popover-max-height': `${maxHeight}px`,
  }
}
