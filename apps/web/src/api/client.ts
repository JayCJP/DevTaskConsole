const tokenStorageKey = 'devtask-console-token'

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

/**
 * 读取本机控制台访问令牌。
 * 优先读 localStorage（刷新、重开标签页后仍保留），
 * 兼容早期版本仅写入 sessionStorage 的情况。
 * @returns 令牌字符串；不存在时返回 null
 */
export function readConsoleToken(): string | null {
  try {
    const persistent = globalThis.localStorage?.getItem(tokenStorageKey)
    if (persistent) return persistent
    const sessionOnly = globalThis.sessionStorage?.getItem(tokenStorageKey)
    if (sessionOnly) {
      // 迁移到 localStorage，后续刷新不再依赖会话级存储
      globalThis.localStorage?.setItem(tokenStorageKey, sessionOnly)
      return sessionOnly
    }
    return null
  } catch {
    // 隐私模式下 storage 可能不可用，退化为无令牌请求
    return null
  }
}

/**
 * 持久化控制台访问令牌，供刷新后自动恢复登录态。
 * @param token 登录成功后拿到的访问令牌
 */
export function saveConsoleToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(tokenStorageKey, token)
    globalThis.sessionStorage?.setItem(tokenStorageKey, token)
  } catch {
    // 忽略存储失败：仅在当前内存会话中使用
  }
}

/**
 * 清除本地保存的令牌（令牌失效时调用）。
 */
export function clearConsoleToken(): void {
  try {
    globalThis.localStorage?.removeItem(tokenStorageKey)
    globalThis.sessionStorage?.removeItem(tokenStorageKey)
  } catch {
    // 忽略存储异常
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readConsoleToken()
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
