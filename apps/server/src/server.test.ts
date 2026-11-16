import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.js'

const webDistExists = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'))
let server = buildServer({ token: 'c'.repeat(64), logger: false })

beforeEach(() => {
  server = buildServer({
    token: 'c'.repeat(64),
    logger: false,
    snapshotProvider: async () => ({
      snapshotAt: '2026-01-01T00:00:00.000Z',
      channels: {
        localHarness: { fetchedAt: null, ok: true, stale: false },
        tapd: { fetchedAt: null, ok: false, stale: false, error: 'Not configured.' },
      },
      requirements: [],
      bugs: [],
      harnessBugs: [],
      openQuestions: [],
      harnessActive: [],
      inbox: [],
      jobs: [],
      crons: [],
    }),
  })
})
afterEach(async () => {
  await server.close()
})

describe('control panel API authentication', () => {
  it('rejects protected API requests without a token', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' })
    expect(response.statusCode).toBe(401)
  })

  it('accepts a valid token through the login endpoint', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'c'.repeat(64) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ authenticated: true })
  })

  it('returns a partial snapshot with unconfigured channels marked as unavailable', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/snapshot',
      headers: { 'x-devtask-token': 'c'.repeat(64) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().channels.tapd).toMatchObject({ ok: false, error: 'Not configured.' })
  })

  it.runIf(webDistExists)('serves the SPA for client-side routes in production', async () => {
    const response = await server.inject({ method: 'GET', url: '/inbox' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('<title>DevTask Console</title>')
  })
})
