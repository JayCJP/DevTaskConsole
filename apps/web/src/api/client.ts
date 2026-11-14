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
  // 只有真正带 body 时才声明 JSON：POST/PUT 无 body 却声明 application/json 时，
  // Fastify 会直接返回 400 FST_ERR_CTP_EMPTY_JSON_BODY，写操作会「点一下就失败」。
  const hasBody = init?.body !== undefined && init.body !== null
  if (hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (token) {
    headers.set('x-devtask-token', token)
  }

  const response = await fetch(path, { ...init, headers })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new ApiError(
      errorMessageOf(payload, response.statusText || `Request failed with status ${response.status}.`),
      response.status,
    )
  }
  return payload as T
}

/**
 * 从错误响应中取出可读信息。
 * 同时兼容本站封装 `{ error: { code, message } }` 与 Fastify 原生 `{ statusCode, code, error, message }`。
 * @param payload 响应 JSON
 * @param fallback 无法解析时的兜底文案
 * @returns 可展示的错误信息
 */
function errorMessageOf(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null) return fallback
  const record = payload as Record<string, unknown>
  const nested = record.error
  if (typeof nested === 'object' && nested !== null) {
    const message = (nested as Record<string, unknown>).message
    if (typeof message === 'string' && message) return message
  }
  if (typeof record.message === 'string' && record.message) return record.message
  return fallback
}
