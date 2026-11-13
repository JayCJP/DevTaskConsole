import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.js'
import { StoryServiceSupervisor } from './services/story-service-supervisor.js'

const accessToken = 'c'.repeat(64)
const workspace = 'C:\\workspaces\\story-one\\repo'
let upstream: Server | undefined
let app: ReturnType<typeof buildServer> | undefined
const requests: Array<{ method: string; url: string; marker: string; lastEventId: string; body: string }> = []

afterEach(async () => {
  await app?.close()
  if (upstream) await new Promise<void>((resolve, reject) =>
    upstream?.close((error) => error ? reject(error) : resolve()))
  app = undefined
  upstream = undefined
  requests.length = 0
})

describe('CodeBuddy job proxy', () => {
  it('proxies jobs and SSE through the server-owned Story mapping', async () => {
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          marker: String(request.headers['x-codebuddy-request'] ?? ''),
          lastEventId: String(request.headers['last-event-id'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (request.url?.endsWith('/stream')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end('data: output-line\n\n')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(request.method === 'GET'
          ? [{ id: 'job-1', name: 'Story job', cwd: workspace, state: 'working', status: 'busy' }]
          : { accepted: true }))
      })
    })
    await listen(upstream)
    const port = (upstream.address() as AddressInfo).port
    const supervisor = new StoryServiceSupervisor({ dataDirectory: 'C:\\devtask-test-data' })
    supervisor.ensureRunning = async (storyId) => ({
      storyId,
      port,
      cwd: workspace,
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    supervisor.inspect = async (storyId) => ({
      storyId,
      port,
      cwd: workspace,
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    app = buildServer({
      token: accessToken,
      logger: false,
      workspacesRoot: 'C:\\workspaces',
      storyServiceSupervisor: supervisor,
      snapshotProvider: async () => ({
        snapshotAt: '2026-01-01T00:00:00.000Z',
        channels: {},
        requirements: [{ storyId: 'STORY-1', title: 'Requirement', workspacePath: 'story-one\\repo' }],
        bugs: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        inbox: [],
        jobs: [],
        crons: [],
        builds: [],
        mergeRequests: [],
      }),
    })

    const jobs = await app.inject({
      method: 'GET',
      url: '/api/v1/stories/STORY-1/jobs',
      headers: { 'x-devtask-token': accessToken },
    })
    const invalidReply = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/jobs/job-1/reply',
      headers: { 'x-devtask-token': accessToken },
      payload: { text: 'continue', bash: true },
    })
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/jobs',
      headers: { 'x-devtask-token': accessToken },
      payload: { name: 'Manual job', prompt: 'Run the selected workflow', cwd: 'C:\\outside\\chosen-by-browser' },
    })
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/jobs/job-1/reply',
      headers: { 'x-devtask-token': accessToken },
      payload: { text: 'continue', bash: false },
    })
    const stream = await app.inject({
      method: 'GET',
      url: '/api/v1/stories/STORY-1/jobs/job-1/stream',
      headers: { 'x-devtask-token': accessToken, 'last-event-id': 'event-17' },
    })

    expect(jobs.statusCode).toBe(200)
    expect(jobs.json()).toEqual([{
      id: 'job-1',
      name: 'Story job',
      cwd: workspace,
      state: 'working',
      status: 'busy',
      storyId: 'STORY-1',
    }])
    expect(invalidReply.statusCode).toBe(400)
    expect(created.statusCode).toBe(201)
    expect(reply.json()).toEqual({ accepted: true })
    expect(stream.headers['content-type']).toContain('text/event-stream')
    expect(stream.body).toContain('data: output-line')
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', marker: '1', url: expect.stringContaining('all=1') }),
      expect.objectContaining({ method: 'GET', marker: '1', lastEventId: 'event-17', url: '/api/v1/jobs/job-1/stream' }),
      expect.objectContaining({
        method: 'POST',
        marker: '1',
        url: '/api/v1/jobs',
        body: JSON.stringify({
          prompt: 'Run the selected workflow',
          name: 'Manual job',
          cwd: workspace,
        }),
      }),
      expect.objectContaining({ method: 'POST', marker: '1', body: JSON.stringify({ text: 'continue', bash: false }) }),
    ]))
  })

  it('requires the console token before making any upstream request', async () => {
    upstream = createServer((_request, response) => {
      requests.push({ method: 'unexpected', url: '', marker: '', lastEventId: '', body: '' })
      response.writeHead(200).end()
    })
    await listen(upstream)
    app = buildServer({ token: accessToken, logger: false })

    const response = await app.inject({ method: 'GET', url: '/api/v1/stories/STORY-1/jobs' })

    expect(response.statusCode).toBe(401)
    expect(requests).toEqual([])
  })
})

async function listen(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
}
