import { describe, expect, it } from 'vitest'
import { positionPopover } from './popoverPosition'

const base = {
  anchor: { left: 400, right: 480, top: 500, bottom: 528 },
  width: 224,
  height: 180,
  viewportWidth: 1440,
  viewportHeight: 900,
  direction: 'up' as const,
  align: 'start' as const,
}

describe('shared popover viewport positioning', () => {
  it('anchors an expanded composer without adding its containing-block offset', () => {
    expect(positionPopover(base)).toMatchObject({ position: 'fixed', left: '400px', top: '312px' })
  })

  it('keeps a tall, wide chooser within a narrow viewport', () => {
    const result = positionPopover({ ...base, viewportWidth: 375, viewportHeight: 812, width: 500, height: 1200 })
    expect(result).toMatchObject({ left: '8px', top: '8px', width: '359px', maxHeight: '796px' })
  })

  it('right-aligns and moves an overflowing downward chooser inside the bottom edge', () => {
    expect(positionPopover({ ...base, align: 'end', direction: 'down', viewportHeight: 600 }))
      .toMatchObject({ left: '256px', top: '412px' })
  })
  it('reserves the anchor when a tall account panel opens above it', () => {
    expect(positionPopover({ ...base, avoidAnchorOverlap: true, viewportWidth: 375, viewportHeight: 812, height: 1200 }))
      .toMatchObject({ top: '8px', maxHeight: '484px' })
  })

})
