import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.js'
import { CronMappingStore } from './aggregator/cron-data.js'
import { ApplicationMappingStore } from './integrations/application-mappings.js'
import { StoryServiceSupervisor } from './services/story-service-supervisor.js'
import { WorkspaceBindingStore } from './workspaces/bindings.js'
import { WorkspaceInitializer } from './workspaces/initializer.js'

const token = 'e'.repeat(64)
const headers = { 'x-devtask-token': token }
/** 与真实 TAPD 一致的 19 位需求 ID */
const firstStoryId = '1138260062001031810'
const secondStoryId = '1138260062001031780'
/** 已发布需求：默认被看板筛选排除 */
const releasedStoryId = '1138260062001031733'
const storyUrl = `https://www.tapd.cn/38260062/prong/stories/view/${firstStoryId}`

let workspacesRoot: string
let dataDirectory: string
let server: ReturnType<typeof buildServer>

beforeEach(async () => {
  workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-board-root-'))
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-board-data-'))
  // 构造一个由 *.code-workspace 描述的工作区，项目声明在 folders 中
  await mkdir(join(workspacesRoot, 'feature-x', 'repo-a', '.git'), { recursive: true })
  await writeFile(join(workspacesRoot, 'feature-x', 'repo-a', '.git', 'HEAD'), 'ref: refs/heads/feat/x\n', 'utf8')
  await writeFile(
    join(workspacesRoot, 'feature-x', 'feature-x.code-workspace'),
    JSON.stringify({ folders: [{ path: 'repo-a' }], settings: {} }),
    'utf8',
  )

  server = buildServer({
    token,
    logger: false,
    workspacesRoot,
    // 所有本地持久化都指向临时目录，避免与其它测试文件争用真实数据目录
    workspaceBindingStore: new WorkspaceBindingStore(dataDirectory),
    workspaceInitializer: new WorkspaceInitializer({ dataDirectory }),
    applicationMappingStore: new ApplicationMappingStore(dataDirectory),
    cronMappingStore: new CronMappingStore(dataDirectory),
    storyServiceSupervisor: new StoryServiceSupervisor({ dataDirectory }),
    tapdAdapter: {
      listOwnedStories: async (owner: string) => ({
        stories: [
          { storyId: firstStoryId, title: '客服需求 A', owner, tapdUrl: storyUrl, statusLabel: '方案中' },
          {
            storyId: secondStoryId,
            title: '客服需求 B',
            owner,
            tapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${secondStoryId}`,
            statusLabel: '开发中',
          },
          {
            storyId: releasedStoryId,
            title: '已发布的需求',
            owner,
            tapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${releasedStoryId}`,
            statusLabel: '已发布',
          },
        ],
        urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
      }),
    },
  })
})

afterEach(async () => {
  await server.close()
  await rm(workspacesRoot, { recursive: true, force: true })
  await rm(dataDirectory, { recursive: true, force: true })
})

describe('board API', () => {
  it('returns TAPD stories with the scanned workspaces', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/board/stories?owner=%E8%94%A1%E6%9D%B0%E9%B9%8F',
      headers,
    })

    expect(response.statusCode).toBe(200)
    const board = response.json()
    expect(board.owner).toBe('蔡杰鹏')
    expect(board.includeReleased).toBe(false)
    expect(board.hiddenReleased).toBe(1)
    expect(board.stories.map((story: { storyId: string }) => story.storyId)).toEqual([firstStoryId, secondStoryId])
    expect(board.workspaces).toMatchObject([{ name: 'feature-x' }])
  })

  it('includes released stories only when asked', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/board/stories?includeReleased=1',
      headers,
    })

    expect(response.statusCode).toBe(200)
    const board = response.json()
    expect(board.includeReleased).toBe(true)
    expect(board.hiddenReleased).toBe(0)
    expect(board.stories.map((story: { storyId: string }) => story.storyId))
      .toEqual([firstStoryId, secondStoryId, releasedStoryId])
  })

  it('binds a story to a workspace using a pasted TAPD link', async () => {
    const saved = await server.inject({
      method: 'PUT',
      url: '/api/v1/workspace-bindings',
      headers,
      payload: { tapdStoryId: storyUrl, workspaceName: 'feature-x', storyTitle: '客服需求 A' },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual([
      expect.objectContaining({ tapdStoryId: firstStoryId, workspaceName: 'feature-x', storyTitle: '客服需求 A' }),
    ])

    const board = await server.inject({
      method: 'GET',
      url: '/api/v1/board/stories',
      headers,
    })
    expect(board.json().stories[0]).toMatchObject({
      storyId: firstStoryId,
      workspaceName: 'feature-x',
      workspacePath: join(workspacesRoot, 'feature-x'),
    })
  })

  it('rejects unknown workspaces and duplicate workspace bindings', async () => {
    const unknown = await server.inject({
      method: 'PUT',
      url: '/api/v1/workspace-bindings',
      headers,
      payload: { tapdStoryId: firstStoryId, workspaceName: 'not-exist' },
    })
    expect(unknown.statusCode).toBe(404)

    await server.inject({
      method: 'PUT',
      url: '/api/v1/workspace-bindings',
      headers,
      payload: { tapdStoryId: firstStoryId, workspaceName: 'feature-x' },
    })
    const conflict = await server.inject({
      method: 'PUT',
      url: '/api/v1/workspace-bindings',
      headers,
      payload: { tapdStoryId: secondStoryId, workspaceName: 'feature-x' },
    })
    expect(conflict.statusCode).toBe(409)
  })

  it('removes a binding', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/workspace-bindings',
      headers,
      payload: { tapdStoryId: firstStoryId, workspaceName: 'feature-x' },
    })

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/workspace-bindings/${firstStoryId}`,
      headers,
    })

    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual([])
  })
})
