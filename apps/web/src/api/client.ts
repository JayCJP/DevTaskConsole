export class ApiError extends Error {
  readonly status: number

  constructor(
    message: string,
    status: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem('devtask-console-token')
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  if (token) {
    headers.set('x-devtask-token', token)
  }

  const response = await fetch(path, { ...init, headers })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const body = isErrorPayload(payload) ? payload.error.message : response.statusText
    throw new ApiError(body || `Request failed with status ${response.status}.`, response.status)
  }
  return payload as T
}

function isErrorPayload(payload: unknown): payload is { error: { message: string } } {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
    return false
  }
  const error = payload.error
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
}
