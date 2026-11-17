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

  it('shows one parent row with folded children and filters released state by children', async () => {
    const parentId = '2000'
    const releasedChild: TapdStory = {
      storyId: '2001',
      title: '已发布子需求',
      status: 'status_9',
      statusLabel: '已发布',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/2001',
    }
    const activeChild: TapdStory = {
      storyId: '2002',
      title: '进行中子需求',
      status: 'status_4',
      statusLabel: '方案中',
      owner: '蔡杰鹏;',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/2002',
    }
    const deps = createDependencies({
      tapd: {
        listOwnedStories: async () => ({
          stories: [releasedChild, activeChild],
          parentStories: [{
            storyId: parentId,
            title: '父需求',
            status: 'status_7',
            statusLabel: '开发中',
            tapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${parentId}`,
            children: [releasedChild, activeChild],
            isParentRow: true,
            parentTapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${parentId}`,
            bugNew: 2,
          }],
          urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
        }),
      },
      bindings: { list: async () => [] },
    })

    const board = await buildBoard('蔡杰鹏', deps)

    // 父行一视同仁展示，父链接指向父需求；已发布子被过滤，隐藏数按子需求计
    expect(board.stories).toHaveLength(1)
    expect(board.stories[0]).toMatchObject({
      storyId: parentId,
      title: '父需求',
      tapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${parentId}`,
      isParentRow: true,
      bugNew: 2,
    })
    expect(board.stories[0]?.children?.map((child) => child.storyId)).toEqual(['2002'])
    expect(board.stories[0]?.children?.[0]?.parentTapdUrl).toBe(
      `https://www.tapd.cn/38260062/prong/stories/view/${parentId}`)
    expect(board.hiddenReleased).toBe(1)
  })

  it('hides a parent row only when all its children are released', async () => {
    const allReleased: TapdStory = {
      storyId: '3001',
      title: '子需求',
      status: 'status_9',
      statusLabel: '已发布',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/3001',
    }
    const deps = createDependencies({
      tapd: {
        listOwnedStories: async () => ({
          stories: [allReleased],
          parentStories: [{
            storyId: '3000',
            title: '父需求',
            tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/3000',
            children: [allReleased],
            isParentRow: true,
            parentTapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/3000',
          }],
          urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
        }),
      },
      bindings: { list: async () => [] },
    })

    const board = await buildBoard('蔡杰鹏', deps)

    expect(board.stories).toHaveLength(0)
    expect(board.hiddenReleased).toBe(1)
  })

  it('does not duplicate a parent row when a workspace is bound to the parent story id', async () => {
    const child: TapdStory = {
      storyId: '4001',
      title: '子需求',
      status: 'status_4',
      statusLabel: '方案中',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/4001',
    }
    // 用户通过「手动添加」粘贴父需求链接，绑定挂在父 ID 上
    const bindings: WorkspaceBinding[] = [
      { tapdStoryId: '4000', workspaceName: 'feature-x', updatedAt: '2026-11-14T00:00:00.000Z' },
    ]
    const deps = createDependencies({
      tapd: {
        listOwnedStories: async () => ({
          stories: [child],
          parentStories: [{
            storyId: '4000',
            title: '父需求',
            tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/4000',
            children: [child],
            isParentRow: true,
            parentTapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/4000',
          }],
          urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
        }),
      },
      bindings: { list: async () => bindings },
    })

    const board = await buildBoard('蔡杰鹏', deps)

    // 工作区只绑定在父需求上：父行显示绑定，子行不携带绑定，也不产生幽灵重复行
    expect(board.stories).toHaveLength(1)
    expect(board.stories[0]).toMatchObject({
      storyId: '4000',
      isParentRow: true,
      workspaceName: 'feature-x',
    })
    expect(board.stories[0]?.children?.[0]).not.toHaveProperty('workspaceName')
  })

  it('keeps a binding visible when its parent row is hidden by the released filter', async () => {
    const releasedChild: TapdStory = {
      storyId: '5001',
      title: '已发布子需求',
      status: 'status_9',
      statusLabel: '已发布',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/5001',
    }
    const bindings: WorkspaceBinding[] = [
      { tapdStoryId: '5000', workspaceName: 'deleted-workspace', updatedAt: '2026-11-14T00:00:00.000Z' },
    ]
    const deps = createDependencies({
      tapd: {
        listOwnedStories: async () => ({
          stories: [releasedChild],
          parentStories: [{
            storyId: '5000',
            title: '父需求',
            tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/5000',
            children: [releasedChild],
            isParentRow: true,
            parentTapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/5000',
          }],
          urlTemplate: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
        }),
      },
      bindings: { list: async () => bindings },
    })

    const board = await buildBoard('蔡杰鹏', deps)

    // 父行被已发布过滤隐藏后，其绑定仍需作为兜底行露出，用户才能解绑
    expect(board.stories).toHaveLength(1)
    expect(board.stories[0]).toMatchObject({
      storyId: '5000',
      inTapdList: false,
      workspaceName: 'deleted-workspace',
    })
  })
})
