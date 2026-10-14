export type AutomationRequestErrorCode =
  | 'not_ready' | 'draining' | 'not_found' | 'invalid_target'
  | 'invalid_request' | 'queued_conflict' | 'storage_failed' | 'admission_unknown'

export class AutomationRequestError extends Error {
  constructor(
    readonly code: AutomationRequestErrorCode,
    message: string,
    readonly status: number,
    readonly runId?: string,
  ) {
    super(message)
  }
}
