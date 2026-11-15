import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '@devtask/shared'
import { buildServer } from './server.js'
import { StoryServiceSupervisor } from './services/story-service-supervisor.js'
import { WorkspaceInitializer } from './workspaces/initializer.js'

const token = 'f'.repeat(64)
const headers = { 'x-devtask-token': token }

/** 最小合法快照：只用于验证并发去重，不关心业务字段 */
const emptySnapshot: Snapshot = {
  snapshotAt: '2026-01-01T00:00:00.000Z',
  channels: {},
  requirements: [],
  bugs: [],
  harnessBugs: [],
  openQuestions: [],
  harnessActive: [],
  inbox: [],
  jobs: [],
  crons: [],
  builds: [],
  mergeRequests: [],
}

let dataDirectory: string
let server: ReturnType<typeof buildServer>

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-snapshot-flight-'))
})

afterEach(async () => {
  await server?.close()
  await rm(dataDirectory, { recursive: true, force: true })
})

/**
 * 构造一个可控速度的快照构建器。
 * @returns 带调用计数的快照构建函数
 */
function createSlowProvider() {
  return vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return emptySnapshot
  })
}

describe('snapshot single flight', () => {
  it('shares one build between concurrent snapshot requests', async () => {
    const provider = createSlowProvider()
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    const responses = await Promise.all([
      server.inject({ method: 'GET', url: '/api/v1/snapshot', headers }),
      server.inject({ method: 'GET', url: '/api/v1/snapshot', headers }),
      server.inject({ method: 'GET', url: '/api/v1/snapshot', headers }),
    ])

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('passes the manual refresh flag through to the provider', async () => {
    const provider = vi.fn(async (_force?: boolean) => emptySnapshot)
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    await server.inject({ method: 'GET', url: '/api/v1/snapshot?refresh=1', headers })
    await server.inject({ method: 'GET', url: '/api/v1/snapshot', headers })

    expect(provider).toHaveBeenNthCalledWith(1, true)
    expect(provider).toHaveBeenNthCalledWith(2, false)
  })

  it('builds again for sequential requests so no snapshot is cached', async () => {
    const provider = createSlowProvider()
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    await server.inject({ method: 'GET', url: '/api/v1/snapshot', headers })
    await server.inject({ method: 'GET', url: '/api/v1/snapshot', headers })

    expect(provider).toHaveBeenCalledTimes(2)
  })
})
