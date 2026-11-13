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
})
