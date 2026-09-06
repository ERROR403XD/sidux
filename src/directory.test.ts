import { describe, expect, it } from 'vitest'
import { compactMcpStatus, normalizeDirectorySkills, normalizeInstalledApps, readDirectoryPages } from './directory'
import { DirectoryMcpReader } from './server/directoryMcpReader'

describe('directory runtime evidence', () => {
  it('keeps connected metadata separate from effective enabled and callable', () => {
    expect(normalizeInstalledApps({ apps: [{ id: 'app', enabled: true, callable: false }] })).toEqual([{ id: 'app', name: '', enabled: true, callable: false }])
    expect(() => normalizeInstalledApps({ apps: [{ id: 'bad', isAccessible: true }] })).toThrow()
  })
  it('preserves same-name skills by path and surfaces discovery errors', () => {
    const result = normalizeDirectorySkills({ data: [{ skills: [
      { name: 'same', path: '/user/SKILL.md', scope: 'user', enabled: false },
      { name: 'same', path: '/project/SKILL.md', scope: 'repo', enabled: true },
      { name: 'plugin', path: '/plugin/SKILL.md', scope: 'user', pluginId: 'p' },
    ], errors: [{ path: '/broken', message: 'invalid frontmatter' }] }] })
    expect(result.installed).toHaveLength(3)
    expect(result.installed.find(skill => skill.path === '/user/SKILL.md')).toMatchObject({ enabled: false, canUninstall: true })
    expect(result.installed.find(skill => skill.path === '/project/SKILL.md')).toMatchObject({ enabled: true, canUninstall: false })
    expect(result.installed.find(skill => skill.path === '/plugin/SKILL.md')).toMatchObject({ enabled: undefined, canUninstall: false })
    expect(result.errors).toEqual(['/broken: invalid frontmatter'])
  })
  it('does not send MCP input schemas to the browser or invent resource counts', () => {
    const native = { name: 'mcp', authStatus: 'oAuth', runtimeStatus: 'failed', tools: { tool: { name: 'tool', inputSchema: { large: 'x'.repeat(100_000) } } }, resources: [{ name: 'r', uri: 'test://r' }] }
    const summary = compactMcpStatus(native, false)
    expect(summary).toMatchObject({ authStatus: 'oAuth', runtimeStatus: 'failed', resourceCount: null, toolCount: 1, tools: [], detailsLoaded: false })
    const detail = compactMcpStatus(native, true)
    expect(detail.resourceCount).toBe(1)
    expect(JSON.stringify(detail).length).toBeLessThan(1000)
    expect(JSON.stringify(detail)).not.toContain('inputSchema')
  })
  it('bounds large tool inventories and identifies the incomplete preview', () => {
    const snapshot = compactMcpStatus({ name: 'big', tools: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), { name: String(i) }])) }, true)
    expect(snapshot.tools).toHaveLength(200)
    expect(snapshot.toolCount).toBe(1000)
    expect(snapshot.truncated).toBe(true)
  })
  it('rejects repeated cursors and bounded non-terminating pagination', async () => {
    let calls = 0
    await expect(readDirectoryPages(async () => { calls += 1; return { data: [], nextCursor: 'same' } })).rejects.toThrow('重复游标')
    expect(calls).toBe(2)
    calls = 0
    await expect(readDirectoryPages(async () => ({ data: [], nextCursor: String(++calls) }))).rejects.toThrow('20 页')
    expect(calls).toBe(20)
  })
  it('coalesces pending MCP requests by thread and rereads after completion', async () => {
    let calls = 0
    const pending: Array<() => void> = []
    const reader = new DirectoryMcpReader(async (_method, params) => {
      calls += 1
      expect(params).toMatchObject({ limit: 25, detail: 'toolsAndAuthOnly' })
      await new Promise<void>(resolve => pending.push(resolve))
      return { data: [{ name: 'server', runtimeStatus: 'connected' }] }
    })
    const first = reader.read('thread-a', false)
    expect(reader.read('thread-a', false)).toBe(first)
    const second = reader.read('thread-b', false)
    expect(calls).toBe(2)
    pending.splice(0).forEach(resolve => resolve())
    await Promise.all([first, second])
    const fresh = reader.read('thread-a', false)
    expect(calls).toBe(3)
    pending.splice(0).forEach(resolve => resolve())
    await fresh
  })
})
