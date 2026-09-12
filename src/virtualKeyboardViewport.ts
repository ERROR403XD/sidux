export function nextLayoutViewportHeight(previous: { width: number; height: number }, current: { width: number; height: number; coarsePointer: boolean; editing: boolean }): number {
  // Some touch browsers resize both viewports for the keyboard. Preserve the
  // baseline only for that case, never for desktop resizing or rotation.
  const keyboardResize = current.coarsePointer && current.editing
    && current.width === previous.width && previous.height - current.height > 120
  return keyboardResize ? previous.height : current.height
}
