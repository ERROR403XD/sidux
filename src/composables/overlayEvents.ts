// Teleported panels still belong to the control that opened them. Parent menus
// must use that ownership when deciding whether a pointer landed outside.
const anchors = new WeakMap<HTMLElement, HTMLElement>()

export function nestedOverlayLayer(anchor: HTMLElement | null, fallback: number): number {
  const parent = anchor?.closest<HTMLElement>('[data-app-popover], [data-app-dialog]')
  return Math.max(fallback, parent ? (Number(getComputedStyle(parent).zIndex) || 0) + 1 : 0)
}

export function setPopoverAnchor(panel: HTMLElement, anchor: HTMLElement): void {
  anchors.set(panel, anchor)
}

export function removePopoverAnchor(panel: HTMLElement): void {
  anchors.delete(panel)
}

export function isOverlayEventInside(event: Event, container: HTMLElement | null): boolean {
  if (!container) return false
  const path = event.composedPath?.() ?? [event.target]
  return path.some((target) => {
    if (!(target instanceof Node)) return false
    let node: Node | null = target
    const visited = new Set<Node>()
    while (node && !visited.has(node)) {
      if (container.contains(node)) return true
      visited.add(node)
      const element: Element | null = node instanceof Element ? node : node.parentElement
      const panel: HTMLElement | null = element?.closest<HTMLElement>('[data-app-popover], [data-app-dialog]') ?? null
      node = panel ? anchors.get(panel) ?? null : null
    }
    return false
  })
}
