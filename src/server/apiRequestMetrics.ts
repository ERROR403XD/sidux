import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord } from './httpUtils.js'

const API_PERF_LOGGING_ENV_KEY = 'CODEXUI_API_PERF_LOGGING'
const API_PERF_MS_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_MS_THRESHOLD'
const API_PERF_BODY_MB_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_BODY_MB_THRESHOLD'
const DEFAULT_API_PERF_MS_THRESHOLD = 300
const DEFAULT_API_PERF_BODY_MB_THRESHOLD = 1
const MB_DIVISOR = 1024 * 1024

function readEnvValueFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = content.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+)\\s*$`, 'm'))
    if (!match) return null
    const rawValue = match[1]?.trim() ?? ''
    if (!rawValue) return null
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      return rawValue.slice(1, -1).trim()
    }
    return rawValue
  } catch {
    return null
  }
}

function parseBooleanEnvFlag(value: string | null | undefined): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function resolveApiPerfLoggingEnabled(): boolean {
  const explicitValue = parseBooleanEnvFlag(process.env[API_PERF_LOGGING_ENV_KEY])
  if (explicitValue !== null) return explicitValue

  const fromEnvLocal = parseBooleanEnvFlag(readEnvValueFromFile('.env.local', API_PERF_LOGGING_ENV_KEY))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseBooleanEnvFlag(readEnvValueFromFile('.env', API_PERF_LOGGING_ENV_KEY))
  if (fromEnv !== null) return fromEnv

  return false
}

const API_PERF_LOGGING_ENABLED = resolveApiPerfLoggingEnabled()

function parseNumberEnvFlag(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function resolveNumericEnvConfig(envKey: string, fallback: number): number {
  const fromProcess = parseNumberEnvFlag(process.env[envKey])
  if (fromProcess !== null) return fromProcess

  const fromEnvLocal = parseNumberEnvFlag(readEnvValueFromFile('.env.local', envKey))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseNumberEnvFlag(readEnvValueFromFile('.env', envKey))
  if (fromEnv !== null) return fromEnv

  return fallback
}

const API_PERF_MS_THRESHOLD = resolveNumericEnvConfig(API_PERF_MS_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_MS_THRESHOLD)
const API_PERF_BODY_MB_THRESHOLD = resolveNumericEnvConfig(API_PERF_BODY_MB_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_BODY_MB_THRESHOLD)

function getChunkByteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding)
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength
  }
  if (ArrayBuffer.isView(chunk)) {
    return chunk.byteLength
  }
  if (chunk instanceof ArrayBuffer) {
    return chunk.byteLength
  }
  return 0
}

export function createApiRequestMetrics(req: IncomingMessage, res: ServerResponse) {
  const requestStartNs = process.hrtime.bigint()
  const rawUrl = req.url ?? ''
  const parsedRequestUrl = rawUrl ? new URL(rawUrl, 'http://localhost') : null
  const requestPath = parsedRequestUrl?.pathname ?? ''
  const requestMethod = req.method ?? 'UNKNOWN'
  const rawContentLength = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length']
  const parsedContentLength = rawContentLength ? Number.parseInt(rawContentLength, 10) : NaN
  let requestBodyBytes: number | null = Number.isFinite(parsedContentLength) && parsedContentLength >= 0
    ? parsedContentLength
    : null
  let responseBodyBytes = 0
  let rpcMethod: string | null = null
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
    responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
    return originalWrite(chunk as never, encoding as never, cb as never)
  }) as typeof res.write
  res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
    responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
    return originalEnd(chunk as never, encoding as never, cb as never)
  }) as typeof res.end
  let didLog = false
  const logApiRequestDuration = () => {
    if (!API_PERF_LOGGING_ENABLED || didLog || !requestPath.startsWith('/codex-api/')) return
    const durationMs = Number((process.hrtime.bigint() - requestStartNs) / 1_000_000n)
    const requestBytes = requestBodyBytes ?? 0
    const bodyMbValue = (requestBytes + responseBodyBytes) / MB_DIVISOR
    const shouldLog = durationMs > API_PERF_MS_THRESHOLD || bodyMbValue > API_PERF_BODY_MB_THRESHOLD
    if (!shouldLog) return
    didLog = true
    const rpcPart = rpcMethod ? `, rpcMethod=${rpcMethod}` : ''
    console.info(`[codex-api-perf] ${requestMethod} ${requestPath} -> ${res.statusCode} (${durationMs}ms, bodyMB=${bodyMbValue.toFixed(1)}${rpcPart})`)
  }
  res.once('finish', logApiRequestDuration)
  res.once('close', logApiRequestDuration)

  return {
    recordRpcRequest: (payload: unknown) => {
      if (payload !== null && payload !== undefined) requestBodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
      const body = asRecord(payload)
      rpcMethod = typeof body?.method === 'string' && body.method ? body.method : null
    },
  }
}
