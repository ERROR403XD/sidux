import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleFileUpload } from '../fileUploadService.js'
import { transcribeRequest } from '../transcriptionService.js'
import { fetchConnectorLogo } from '../connectorLogoService.js'
import { getErrorMessage, setJson } from '../httpUtils.js'

export function createMediaRoutes() {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method === 'POST' && url.pathname === '/codex-api/upload-file') {
      handleFileUpload(req, res)
      return true
    }
    if (req.method === 'POST' && url.pathname === '/codex-api/transcribe') {
      const upstream = await transcribeRequest(req)
      res.statusCode = upstream.status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(upstream.body)
      return true
    }
    if (req.method !== 'GET' || url.pathname !== '/codex-api/connector-logo') return false
    const src = url.searchParams.get('src')?.trim() ?? ''
    if (!src) {
      setJson(res, 400, { error: 'Missing src' })
      return true
    }
    try {
      const logo = await fetchConnectorLogo(src)
      res.statusCode = 200
      res.setHeader('Content-Type', logo.contentType)
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.end(logo.body)
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch connector logo') })
    }
    return true
  }
}
