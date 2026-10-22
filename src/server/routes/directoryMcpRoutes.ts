import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DirectoryMcpReader } from '../directoryMcpReader.js'
import { getErrorMessage, setJson } from '../httpUtils.js'

export function createDirectoryMcpRoutes(reader: Pick<DirectoryMcpReader, 'read'>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'GET' || url.pathname !== '/codex-api/directory/mcps') return false
    try {
      const data = await reader.read(url.searchParams.get('threadId')?.trim() || '', url.searchParams.get('full') === 'true')
      setJson(res, 200, { data })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'MCP 状态读取失败') })
    }
    return true
  }
}
