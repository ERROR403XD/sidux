import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createNotificationService } from '../notificationService.js'

export function createNotificationRoutes(service: ReturnType<typeof createNotificationService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'GET' || url.pathname !== '/codex-api/events') return false
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const unsubscribe = service.subscribe(notification => {
      if (res.writableEnded || res.destroyed) return
      res.write(`data: ${JSON.stringify(notification)}\n\n`)
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
    const keepAlive = setInterval(() => {
      res.write(': ping\n\n')
    }, 15000)

    const close = () => {
      clearInterval(keepAlive)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }
    req.on('close', close)
    req.on('aborted', close)
    return true
  }
}
