import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiRequest', () => {
  it('surfaces API errors instead of returning an empty success value', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'local-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Data source unavailable.' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })),
    )

    await expect(apiRequest('/api/v1/snapshot')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Data source unavailable.',
      status: 503,
    } satisfies Partial<ApiError>)
  })

  it('omits the JSON content type for requests without a body', async () => {
    // 无 body 却声明 application/json 时，Fastify 会返回 400 FST_ERR_CTP_EMPTY_JSON_BODY
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await apiRequest('/api/v1/stories/STORY-1/service', { method: 'POST' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).has('content-type')).toBe(false)
  })

  it('keeps the JSON content type when a body is present', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await apiRequest('/api/v1/crons', { method: 'POST', body: JSON.stringify({ cron: '5,25,45 * * * *' }) })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('reads the message from Fastify native error payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY', error: 'Bad Request', message: 'Body cannot be empty.' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )),
    )

    await expect(apiRequest('/api/v1/crons', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Body cannot be empty.',
      status: 400,
    } satisfies Partial<ApiError>)
  })
})
