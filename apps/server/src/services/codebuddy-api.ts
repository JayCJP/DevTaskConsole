export class CodeBuddyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CodeBuddyApiError'
  }
}

export class CodeBuddyApi {
  async request(
    port: number,
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
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
      signal: AbortSignal.timeout(30_000),
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
