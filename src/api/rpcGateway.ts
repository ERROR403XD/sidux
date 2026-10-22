import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import { observeCompactionHistory } from './threadCompaction'

export async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    const result = await rpcCall<T>(method, params)
    if (method === 'thread/read' || method === 'thread/resume') observeCompactionHistory(result)
    return result
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}
