import type { UiThread } from './types/codex'

type Row = Pick<UiThread, 'id' | 'inProgress' | 'unread'>

/** Display state for one activation of the Active filter; never persisted or used for execution. */
export class ActiveSidebarSession {
  enabled = false
  readonly retainedIds = new Set<string>()
  private rows = new Map<string, Row>()
  private selectedId = ''

  reset(enabled: boolean, rows: Row[], selectedId: string): void {
    this.enabled = enabled
    this.retainedIds.clear()
    this.rows.clear()
    this.selectedId = selectedId
    this.update(rows, selectedId)
  }

  update(rows: Row[], selectedId: string): void {
    if (!this.enabled) return
    const next = new Map(rows.map(row => [row.id, { id: row.id, inProgress: row.inProgress, unread: row.unread }]))
    for (const row of next.values()) {
      if (row.inProgress) this.retainedIds.add(row.id)
      // Acknowledgement may arrive from another window. A false flag at completion
      // alone is not acknowledgement: the blue-dot event can arrive later.
      if (!row.inProgress && row.id !== selectedId && this.rows.get(row.id)?.unread && !row.unread) this.remove(row.id)
    }
    if (this.selectedId !== selectedId && !next.get(this.selectedId)?.inProgress) this.remove(this.selectedId)
    for (const id of this.rows.keys()) {
      if (!next.has(id)) this.remove(id)
    }
    this.rows = next
    this.selectedId = selectedId
  }

  private remove(id: string): void {
    this.retainedIds.delete(id)
  }

  started(id: string): void {
    if (this.enabled && this.rows.has(id)) this.retainedIds.add(id)
  }

}
