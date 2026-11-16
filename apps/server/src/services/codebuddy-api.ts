export class CodeBuddyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CodeBuddyApiError'
  }
}

/**
 * 解包 CodeBuddy 实例列表响应。
 * 官方 `GET /api/v1/jobs` 返回 `{ data: { jobs: [...] } }`（AgentJobList），
 * 而不是裸数组；直接按数组校验会把正常响应当成「响应非法」，
 * 表现为创建实例成功后列表始终为空。这里同时兼容裸数组与 `{ jobs }` 两种形态。
 * @param payload 上游原始响应
 * @returns 实例数组；无法识别包装结构时返回 undefined
 */
export function extractJobList(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const data = record.data
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    const jobs = (data as Record<string, unknown>).jobs
    if (Array.isArray(jobs)) return jobs
  }
  if (Array.isArray(record.jobs)) return record.jobs
  return undefined
}

/**
 * 解包 CodeBuddy 单实例响应。
 * `POST /api/v1/jobs` 返回 `{ data: AgentJob }`，
 * `GET /api/v1/jobs/{id}` 返回 `{ data: { job: AgentJob } }`，两种包装都要支持。
 * @param payload 上游原始响应
 * @returns 实例对象；无法识别时返回 undefined
 */
export function extractJob(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const data = record.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const inner = data as Record<string, unknown>
    const job = inner.job
    if (typeof job === 'object' && job !== null && !Array.isArray(job)) return job as Record<string, unknown>
    return inner
  }
  const job = record.job
  if (typeof job === 'object' && job !== null && !Array.isArray(job)) return job as Record<string, unknown>
  return record
}

/**
 * 解包实例偏好响应。
 * `GET/PUT /api/v1/jobs/prefs` 返回 `{ data: { prefs: AgentJobPrefs } }`。
 * @param payload 上游原始响应
 * @returns 偏好对象；缺省时返回空对象，由 schema 提供默认值
 */
export function extractJobPrefs(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const data = record.data
  if (typeof data === 'object' && data !== null) {
    const prefs = (data as Record<string, unknown>).prefs
    if (prefs) return prefs
  }
  if (record.prefs) return record.prefs
  return payload
}

export class CodeBuddyApi {
  /**
   * @param defaultTimeoutMs 实例默认超时；默认 30s。ScheduledTaskClient 等封装调用方不传单次超时时用它，
   * runtime 快照链路注入 3s 实例以封顶首屏等待
   */
  constructor(private readonly defaultTimeoutMs = 30_000) {}

  /**
   * 发起一次 CodeBuddy HTTP 请求。
   * @param port 实例端口
   * @param path 请求路径
   * @param method HTTP 方法
   * @param body 可选请求体
   * @param timeoutMs 可选单次超时；缺省时用实例默认值
   * @returns 解析后的响应
   */
  async request(
    port: number,
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    body?: unknown,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    const response = await fetch(this.url(port, path), {
      method,
      headers: {
        accept: 'application/json',
        'X-CodeBuddy-Request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new CodeBuddyApiError(response.status, `CodeBuddy request failed with HTTP ${response.status}.`)
    // 删除类接口（如 DELETE /scheduled-tasks/{id}）返回 204 且没有响应体
    if (response.status === 204) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        return await response.json() as unknown
      } catch {
        throw new CodeBuddyApiError(502, 'CodeBuddy returned invalid JSON.')
      }
    }
    const text = await response.text()
    return text.length > 0 ? text : undefined
  }

  async openStream(port: number, path: string, signal: AbortSignal, lastEventId?: string): Promise<Response> {
    const response = await fetch(this.url(port, path), {
      headers: {
        accept: 'text/event-stream',
        'X-CodeBuddy-Request': '1',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      redirect: 'error',
      signal,
    })
    if (!response.ok) throw new CodeBuddyApiError(response.status, `CodeBuddy stream failed with HTTP ${response.status}.`)
    return response
  }

  private url(port: number, path: string): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith('/api/v1/')) {
      throw new Error('Invalid CodeBuddy proxy target.')
    }
    return `http://127.0.0.1:${port}${path}`
  }
}
