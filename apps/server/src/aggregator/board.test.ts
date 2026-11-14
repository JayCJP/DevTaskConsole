import { describe, expect, it } from 'vitest'
import type { TapdStory, WorkspaceBinding, WorkspaceSummary } from '@devtask/shared'
import { buildBoard, type BoardDependencies } from './board.js'

const workspace: WorkspaceSummary = {
  name: 'feature-x',
  path: 'D:\\test-blanch\\feature-x',
  workspaceFile: 'D:\\test-blanch\\feature-x\\feature-x.code-workspace',
  missingProjects: [],
  projects: [],
}

/**
 * 构造一个看板依赖替身。
 * @param overrides 需要覆盖的依赖项
 * @returns 看板依赖
 */
function createDependencies(overrides: Partial<BoardDependencies> = {}): BoardDependencies {
  const stories: TapdStory[] = [
    {
      storyId: '1001',
      title: '客服需求 A',
      status: 'status_4',
      statusLabel: '方案中',
      owner: '蔡杰鹏;',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1001',
    },
    {
      storyId: '1002',
      title: '客服需求 B',
      status: 'status_9',
      statusLabel: '已发布',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1002',
    },
  ]
  return {
    tapd: {
      listOwnedStories: async () => ({
        stories,
        urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
      }),
    },
    bindings: { list: async () => [] },
    workspaces: async () => [workspace],
    ...overrides,
  }
}

describe('board aggregation', () => {
  it('lists TAPD stories and resolves their bound workspace', async () => {
    const bindings: WorkspaceBinding[] = [
      { tapdStoryId: '1001', workspaceName: 'feature-x', updatedAt: '2026-11-14T00:00:00.000Z' },
    ]

    const board = await buildBoard('蔡杰鹏', createDependencies({ bindings: { list: async () => bindings } }))

    expect(board).toMatchObject({ owner: '蔡杰鹏', ok: true, includeReleased: false })
    expect(board.stories).toHaveLength(1)
    expect(board.stories[0]).toMatchObject({
      storyId: '1001',
      title: '客服需求 A',
      statusLabel: '方案中',
      inTapdList: true,
      workspaceName: 'feature-x',
      workspacePath: workspace.path,
    })
    expect(board.workspaces).toEqual([workspace])
  })

  it('excludes released stories by default and reports how many were hidden', async () => {
    const board = await buildBoard('蔡杰鹏', createDependencies())

    expect(board.includeReleased).toBe(false)
    expect(board.hiddenReleased).toBe(1)
    expect(board.stories.map((story) => story.storyId)).toEqual(['1001'])
  })

  it('includes released stories when explicitly requested', async () => {
    const board = await buildBoard('蔡杰鹏', createDependencies(), { includeReleased: true })

    expect(board.includeReleased).toBe(true)
    expect(board.hiddenReleased).toBe(0)
    expect(board.stories.map((story) => story.storyId)).toEqual(['1001', '1002'])
  })

  it('treats status_9 as released when TAPD returns no status label', async () => {
    const board = await buildBoard('蔡杰鹏', createDependencies({
      tapd: {
        listOwnedStories: async () => ({
          stories: [{
            storyId: '1003',
            title: '无状态中文名的需求',
            status: 'status_9',
            tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1003',
          }],
          urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
        }),
      },
    }))

    expect(board.stories).toEqual([])
    expect(board.hiddenReleased).toBe(1)
  })

  it('keeps locally bound stories visible when TAPD is unavailable', async () => {
    const bindings: WorkspaceBinding[] = [{
      tapdStoryId: '1001',
      workspaceName: 'feature-x',
      storyTitle: '手动添加的需求',
      updatedAt: '2026-11-14T00:00:00.000Z',
    }]
    const dependencies = createDependencies({
      tapd: {
        listOwnedStories: async () => {
          throw new Error('TAPD MCP is not configured.')
        },
      },
      bindings: { list: async () => bindings },
    })

    const board = await buildBoard('蔡杰鹏', dependencies)

    expect(board.ok).toBe(false)
    expect(board.fetchedAt).toBeNull()
    expect(board.error).toContain('TAPD MCP is not configured.')
    expect(board.stories).toEqual([
      expect.objectContaining({
        storyId: '1001',
        title: '手动添加的需求',
        inTapdList: false,
        workspaceName: 'feature-x',
        workspacePath: workspace.path,
      }),
    ])
  })

  it('keeps the binding name when the workspace directory is gone', async () => {
    const bindings: WorkspaceBinding[] = [
      { tapdStoryId: '1001', workspaceName: 'deleted-workspace', updatedAt: '2026-11-14T00:00:00.000Z' },
    ]

    const board = await buildBoard('蔡杰鹏', createDependencies({ bindings: { list: async () => bindings } }))

    expect(board.stories[0]).toMatchObject({ workspaceName: 'deleted-workspace', inTapdList: true })
    expect(board.stories[0]?.workspacePath).toBeUndefined()
  })
})
