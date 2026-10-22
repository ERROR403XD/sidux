import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteRequestContext = {
  readJsonBody: (request: IncomingMessage) => Promise<unknown>
}

export function createRouteDispatcher<T extends RouteRequestContext = RouteRequestContext>(
  handlers: readonly ((request: IncomingMessage, response: ServerResponse, url: URL, context: T) => Promise<boolean>)[],
): (request: IncomingMessage, response: ServerResponse, url: URL, context: T) => Promise<boolean> {
  return async (request, response, url, context) => {
    for (const handler of handlers) {
      const handled = await handler(request, response, url, context)
      if (handled) return true
    }
    return false
  }
}

export class JsonObjectBodyError extends Error {
  readonly statusCode = 400

  constructor() {
    super('Expected a JSON object.')
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) return payload.message

  const record = asRecord(payload)
  if (!record) return fallback

  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (message) return message

  const error = record.error
  if (typeof error === 'string' && error.trim().length > 0) return error.trim()

  const nestedError = asRecord(error)
  const nestedMessage = typeof nestedError?.message === 'string' ? nestedError.message.trim() : ''
  if (nestedMessage) return nestedMessage

  return fallback
}

export function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

export async function readJsonObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new JsonObjectBodyError()
  }
  const record = asRecord(parsed)
  if (!record) throw new JsonObjectBodyError()
  return record
}

export async function readAnyJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function getErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

export function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

export function failBridgeRequest(res: ServerResponse, error: unknown): void {
  const message = getErrorMessage(error, 'Unknown bridge error')
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : new Error(message))
    return
  }
  setJson(res, 502, { error: message })
}
