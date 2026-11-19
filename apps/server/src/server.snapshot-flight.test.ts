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

  it('passes segment filters through so pipeline/inbox can refresh without TAPD', async () => {
    // segments=local 表示只重扫本地段、复用 TAPD 缓存，供 pipeline/inbox 页使用
    const provider = vi.fn(async (_force?: boolean, _segments?: string[]) => emptySnapshot)
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    await server.inject({ method: 'GET', url: '/api/v1/snapshot?segments=local', headers })

    expect(provider).toHaveBeenCalledWith(false, ['local'])
  })

  it('rejects unknown segment names', async () => {
    const provider = vi.fn(async () => emptySnapshot)
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    const response = await server.inject({ method: 'GET', url: '/api/v1/snapshot?segments=tapd,unknown', headers })

    expect(response.statusCode).toBe(400)
    expect(provider).not.toHaveBeenCalled()
  })

  it('lets refresh=1 override segments so manual refresh still rebuilds everything', async () => {
    const provider = vi.fn(async () => emptySnapshot)
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    // force 与 segments 同时出现：force 优先（buildSnapshotResult 里 forceLocal/forceTapd 均为 true）
    await server.inject({ method: 'GET', url: '/api/v1/snapshot?refresh=1&segments=local', headers })

    expect(provider).toHaveBeenCalledWith(true, ['local'])
  })

  it('treats an empty segments value as a normal request', async () => {
    const provider = vi.fn(async () => emptySnapshot)
    server = buildServer({
      token,
      logger: false,
      snapshotProvider: provider,
      workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
      storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    })

    const response = await server.inject({ method: 'GET', url: '/api/v1/snapshot?segments=', headers })

    expect(response.statusCode).toBe(200)
    // 空字符串被当作无 segments，只传 force，保持旧调用形态
    expect(provider).toHaveBeenCalledWith(false)
  })
})
