import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '@devtask/shared'

// 所有被测依赖的替身必须 hoist 到 vi.mock 工厂之前声明
const mocks = vi.hoisted(() => ({
  codebuddyVersion: '2.185.0' as string | null,
  readHarness: vi.fn(),
  tapdCheck: vi.fn(),
  tapdAggregate: vi.fn(),
  tapdExport: vi.fn(),
  gitlabCheck: vi.fn(),
  gitlabUser: vi.fn(),
  devopsCheck: vi.fn(),
  devopsUser: vi.fn(),
  svcList: vi.fn(),
  svcInspect: vi.fn(),
  codebuddyRequest: vi.fn(),
  cronResolve: vi.fn(),
  cronList: vi.fn(),
}))

// node:child_process 用 callback 风格 mock，供 snapshot.ts 中 promisify(exec) 使用
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    exec: (
      _cmd: string,
      _options: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (mocks.codebuddyVersion === null) {
        cb(new Error('command not found'), { stdout: '', stderr: '' })
        return
      }
      cb(null, { stdout: `${mocks.codebuddyVersion}\n`, stderr: '' })
    },
  }
})

// 用 importOriginal 保留纯函数与其它导出，只替换单例背后的适配器实现
vi.mock('./local-harness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./local-harness.js')>()
  return { ...actual, readLocalHarness: mocks.readHarness }
})
vi.mock('../integrations/tapd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/tapd.js')>()
  return {
    ...actual,
    TapdAdapter: class {
      checkConnection = mocks.tapdCheck
      aggregate = mocks.tapdAggregate
      exportRawEnrichment = mocks.tapdExport
    },
  }
})
vi.mock('../integrations/gitlab.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/gitlab.js')>()
  return {
    ...actual,
    GitLabAdapter: class {
      checkConnection = mocks.gitlabCheck
      getCurrentUser = mocks.gitlabUser
    },
  }
})
vi.mock('../integrations/devops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/devops.js')>()
  return {
    ...actual,
    DevOpsAdapter: class {
      checkConnection = mocks.devopsCheck
      getLoginUser = mocks.devopsUser
    },
  }
})
vi.mock('../services/story-service-supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/story-service-supervisor.js')>()
  return {
    ...actual,
    StoryServiceSupervisor: class {
      list = mocks.svcList
      inspect = mocks.svcInspect
    },
  }
})
vi.mock('../services/codebuddy-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/codebuddy-api.js')>()
  return {
    ...actual,
    CodeBuddyApi: class {
      constructor(_timeoutMs?: number) {}
      request = mocks.codebuddyRequest
    },
  }
})
vi.mock('../services/scheduled-tasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/scheduled-tasks.js')>()
  return {
    ...actual,
    ScheduledTaskClient: class {
      constructor(_api?: unknown) {}
      resolveSessionId = mocks.cronResolve
      list = mocks.cronList
    },
  }
})

import { buildSnapshotResult } from './snapshot.js'
import { makeCacheEntry } from './snapshot-cache.fixture.js'

let workspacesRoot: string
let dataDirectory: string

/** 构造一个带 workspacePath 的本地需求，用于 runtime 归属核对 */
function requirement(storyId: string, workspacePath: string): Requirement {
  return { storyId, title: storyId, workspacePath }
}

beforeEach(async () => {
  mocks.codebuddyVersion = '2.185.0'
  workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-snapshot-behavior-'))
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-snapshot-behavior-data-'))
  process.env.DEVTASK_DATA_DIR = dataDirectory

  // 默认：本地扫描/TAPD/连通性/服务都返回空，避免触达真实环境
  mocks.readHarness.mockReset().mockResolvedValue({
    requirements: [],
    harnessBugs: [],
    openQuestions: [],
    harnessActive: [],
    errors: [],
  })
  mocks.tapdCheck.mockReset().mockResolvedValue(false)
  mocks.tapdAggregate.mockReset().mockResolvedValue({ requirements: [], bugs: [] })
  mocks.tapdExport.mockReset().mockReturnValue(new Map())
  mocks.gitlabCheck.mockReset().mockResolvedValue(false)
  mocks.gitlabUser.mockReset().mockResolvedValue(null)
  mocks.devopsCheck.mockReset().mockResolvedValue(false)
  mocks.devopsUser.mockReset().mockResolvedValue(null)
  mocks.svcList.mockReset().mockResolvedValue([])
  mocks.svcInspect.mockReset().mockResolvedValue(null)
  mocks.codebuddyRequest.mockReset().mockResolvedValue([])
  mocks.cronResolve.mockReset().mockResolvedValue('session-1')
  mocks.cronList.mockReset().mockResolvedValue([])
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(workspacesRoot, { recursive: true, force: true })
  await rm(dataDirectory, { recursive: true, force: true })
  delete process.env.DEVTASK_DATA_DIR
})

describe('buildSnapshotResult 缓存行为（方案 §7 要点 2/10/11）', () => {
  it('命中缓存时跳过磁盘扫描与 TAPD，返回的仍是缓存里的本地需求', async () => {
    const sentinel = requirement('FROM-CACHE', 'cached-workspace')
    const cachedLocal = { ...makeCacheEntry().segments.local, requirements: [sentinel] }

    const result = await buildSnapshotResult(workspacesRoot, {
      cachedLocal,
      cachedTapd: makeCacheEntry().segments.tapd,
    })

    expect(mocks.readHarness).not.toHaveBeenCalled()
    expect(mocks.tapdCheck).not.toHaveBeenCalled()
    expect(mocks.tapdAggregate).not.toHaveBeenCalled()
    expect(result.rebuilt).toEqual({ local: false, tapd: false })
    // 缓存里的哨兵需求存活，证明组装用的是缓存段而非磁盘重扫
    expect(result.snapshot.requirements).toEqual([sentinel])
  })

  it('连通性 60s 内复用、过期或强制刷新时重拉', async () => {
    vi.useFakeTimers()
    // 第一次强制构建，确保内存缓存被写入
    await buildSnapshotResult(workspacesRoot, { force: true })
    const baseline = mocks.gitlabCheck.mock.calls.length
    expect(baseline).toBeGreaterThan(0)

    // 60s 内的普通请求复用内存缓存，不打远端
    await buildSnapshotResult(workspacesRoot, { force: false })
    expect(mocks.gitlabCheck).toHaveBeenCalledTimes(baseline)

    // 超过 TTL 后重拉
    vi.advanceTimersByTime(61_000)
    await buildSnapshotResult(workspacesRoot, { force: false })
    expect(mocks.gitlabCheck).toHaveBeenCalledTimes(baseline + 1)

    // 手动刷新无条件重拉
    await buildSnapshotResult(workspacesRoot, { force: true })
    expect(mocks.gitlabCheck).toHaveBeenCalledTimes(baseline + 2)
  })

  it('CodeBuddy CLI 已安装时，通道 ok 且 error 字段承载版本号', async () => {
    mocks.codebuddyVersion = '2.185.0'

    const result = await buildSnapshotResult(workspacesRoot, { force: true })

    expect(result.snapshot.channels.codebuddy.ok).toBe(true)
    expect(result.snapshot.channels.codebuddy.error).toContain('2.185.0')
  })

  it('CodeBuddy CLI 未安装时，通道不 ok 且 error 字段含安装链接', async () => {
    mocks.codebuddyVersion = null

    const result = await buildSnapshotResult(workspacesRoot, { force: true })

    expect(result.snapshot.channels.codebuddy.ok).toBe(false)
    expect(result.snapshot.channels.codebuddy.error).toContain(
      'https://www.codebuddy.cn/docs/cli/quickstart',
    )
  })

  it('TAPD MCP 连接成功但取数失败时，通道仍标记为 ok（连接状态与取数解耦）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const withTapdStory = {
      storyId: 'S-TAPD',
      title: '带 TAPD 绑定的需求',
      workspacePath: 'w',
      tapdStoryId: '123456',
    }
    mocks.readHarness.mockResolvedValue({
      requirements: [withTapdStory],
      harnessBugs: [],
      openQuestions: [],
      harnessActive: [],
      errors: [],
    })
    mocks.tapdCheck.mockResolvedValue(true)
    mocks.tapdAggregate.mockRejectedValue(
      new Error('TAPD did not return requested Stories: 123456.'),
    )

    const result = await buildSnapshotResult(workspacesRoot, { force: true })

    expect(mocks.tapdCheck).toHaveBeenCalled()
    expect(mocks.tapdAggregate).toHaveBeenCalled()
    // 核心断言：连接成功即视为链接正常，取数失败不再把通道标红
    expect(result.snapshot.channels.tapd.ok).toBe(true)
    expect(result.snapshot.channels.tapd.error).toBeUndefined()
    // 取数失败时没有增强数据
    expect(result.snapshot.requirements[0]).toMatchObject(withTapdStory)
  })

  it('runtime 并发拉取多个服务，并把单次超时设为 3s', async () => {
    const services = [
      { storyId: 'S1', cwd: resolve(workspacesRoot, 's1'), port: 4101, status: 'running' },
      { storyId: 'S2', cwd: resolve(workspacesRoot, 's2'), port: 4102, status: 'running' },
    ]
    mocks.svcList.mockResolvedValue(services)
    mocks.svcInspect.mockImplementation(async (storyId: string) => {
      const service = services.find((item) => item.storyId === storyId)
      return service ? { ...service } : null
    })
    // 用一个闸门让两个请求都挂起：只有并发才会在释放前累计到 2 次调用
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    mocks.codebuddyRequest.mockImplementation(async () => {
      await gate
      return []
    })

    const cachedLocal = {
      ...makeCacheEntry().segments.local,
      requirements: [requirement('S1', 's1'), requirement('S2', 's2')],
    }
    // 不传 force：local 段走缓存（带 workspacePath），runtime 段无论 force 与否都会实时拉取
    const pending = buildSnapshotResult(workspacesRoot, {
      cachedLocal,
      cachedTapd: makeCacheEntry().segments.tapd,
    })
    // 两个请求都挂起时若已累计到 2 次调用，证明它们是并发发出的（串行时只会到第 1 次）
    await vi.waitFor(() => expect(mocks.codebuddyRequest).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    })
    release()
    const result = await pending

    expect(result.snapshot.jobs).toEqual([])
    // 第 5 个参数是显式传入的 3s 超时（方案 §3.8）
    for (const call of mocks.codebuddyRequest.mock.calls) {
      expect(call[4]).toBe(3_000)
    }
  })
})
