import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Requirement, WorkspaceSummary } from '@devtask/shared'
import { buildWorkspacePipelines } from './workspace-pipelines.js'

/** 跨平台的工作区扫描根目录（只做字符串归属计算，不落盘） */
const root = join(tmpdir(), 'devtask-workspace-pipelines')

/**
 * 构造一个按 `folders` 声明顺序排列的工作区：repo-a 是第一个项目。
 * @returns 工作区摘要
 */
function workspaceFixture(): WorkspaceSummary {
  return {
    name: 'feature-x',
    path: join(root, 'feature-x'),
    workspaceFile: join(root, 'feature-x', 'feature-x.code-workspace'),
    missingProjects: [],
    projects: [
      { name: 'repo-a', path: join(root, 'feature-x', 'repo-a'), branch: 'feat/x', worktree: true },
      { name: 'repo-b', path: join(root, 'feature-x', 'repo-b'), branch: 'feat/y', worktree: true },
    ],
  }
}

/**
 * 构造一条落在指定目录下的需求。
 * @param storyId Story ID
 * @param workspacePath 工作区相对路径
 * @returns 需求对象
 */
function requirementFixture(storyId: string, workspacePath: string): Requirement {
  return { storyId, title: `Story ${storyId}`, status: 'running', phase: 2, workspacePath }
}

describe('workspace pipelines', () => {
  it('only recognizes the story placed in the first project', () => {
    const result = buildWorkspacePipelines({
      workspacesRoot: root,
      workspaces: [workspaceFixture()],
      // 第二个项目里的 Story 与工作区根目录的 Story 都不参与流水线
      requirements: [
        requirementFixture('STORY-FIRST', 'feature-x/repo-a'),
        requirementFixture('STORY-SECOND', 'feature-x/repo-b'),
        requirementFixture('STORY-ROOT', 'feature-x'),
      ],
      harnessActive: [{ storyId: 'STORY-FIRST', title: 'Story STORY-FIRST', workspacePath: 'feature-x/repo-a' }],
      mergeRequests: [
        {
          projectId: 1,
          id: '11',
          title: 'MR for STORY-FIRST',
          sourceBranch: 'feat/x',
          targetBranch: 'dev',
          state: 'opened',
          storyId: 'STORY-FIRST',
        },
        {
          projectId: 1,
          id: '12',
          title: '项目分支上的 MR',
          sourceBranch: 'feat/x',
          targetBranch: 'dev',
          state: 'opened',
        },
        {
          projectId: 1,
          id: '13',
          title: '其它分支的 MR',
          sourceBranch: 'feat/y',
          targetBranch: 'dev',
          state: 'opened',
        },
      ],
      builds: [
        { id: 'b1', app: 'repo-a', branch: 'feat/x', succeed: true },
        { id: 'b2', app: 'repo-b', branch: 'feat/y', succeed: true },
      ],
      branches: [{ app: 'repo-b', name: 'origin/dev' }],
      crons: [
        { id: 'cron-story', storyId: 'STORY-FIRST', cron: '0 * * * *' },
        { id: 'cron-loose', cron: '0 9 * * *', workspacePath: 'feature-x/repo-a' },
      ],
      jobs: [{
        id: 'job-1',
        storyId: 'STORY-FIRST',
        name: 'Job',
        cwd: join(root, 'feature-x', 'repo-a'),
        state: 'idle',
        status: 'idle',
      }],
    })

    const [pipeline] = result.workspacePipelines
    expect(pipeline?.name).toBe('feature-x')
    // 第一个项目固定为 folders[0]，不受字母序影响
    expect(pipeline?.primaryProject).toMatchObject({ name: 'repo-a', branch: 'feat/x', worktree: true })
    expect(pipeline?.story?.requirement.storyId).toBe('STORY-FIRST')
    expect(pipeline?.story?.harnessActive).toBe(true)
    expect(pipeline?.storyCandidates).toBe(1)
    // MR = Story 的 MR + 第一个项目当前分支上的 MR，其它分支不计入
    expect(pipeline?.mergeRequests.map((mergeRequest) => mergeRequest.id)).toEqual(['11', '12'])
    expect(pipeline?.builds.map((build) => build.id)).toEqual(['b1'])
    expect(pipeline?.branches).toEqual([])
    expect(pipeline?.crons.map((cron) => cron.id)).toEqual(['cron-story', 'cron-loose'])
    expect(pipeline?.story?.jobs.map((job) => job.id)).toEqual(['job-1'])
  })

  it('keeps a single story when the first project holds several plans', () => {
    const result = buildWorkspacePipelines({
      workspacesRoot: root,
      workspaces: [workspaceFixture()],
      requirements: [
        requirementFixture('STORY-B', 'feature-x/repo-a'),
        requirementFixture('STORY-A', 'feature-x/repo-a'),
      ],
      harnessActive: [],
      mergeRequests: [],
      builds: [],
      branches: [],
      crons: [],
      jobs: [],
    })

    const [pipeline] = result.workspacePipelines
    expect(pipeline?.storyCandidates).toBe(2)
    // storyId 升序取第一份，保证多次刷新结果一致
    expect(pipeline?.story?.requirement.storyId).toBe('STORY-A')
  })

  it('leaves the story empty when the first project has no plans', () => {
    const result = buildWorkspacePipelines({
      workspacesRoot: root,
      workspaces: [workspaceFixture()],
      requirements: [
        requirementFixture('STORY-SECOND', 'feature-x/repo-b'),
        requirementFixture('STORY-OUTSIDE', 'undeclared-dir'),
      ],
      harnessActive: [],
      mergeRequests: [],
      builds: [],
      branches: [],
      crons: [],
      jobs: [],
    })

    const [pipeline] = result.workspacePipelines
    expect(pipeline?.primaryProject?.name).toBe('repo-a')
    expect(pipeline?.story).toBeUndefined()
    expect(pipeline?.storyCandidates).toBe(0)
  })

  it('skips the anchor when the workspace declares no project', () => {
    const result = buildWorkspacePipelines({
      workspacesRoot: root,
      workspaces: [{ name: 'empty', path: join(root, 'empty'), missingProjects: [], projects: [] }],
      requirements: [requirementFixture('STORY-1', 'empty')],
      harnessActive: [],
      mergeRequests: [],
      builds: [],
      branches: [],
      crons: [],
      jobs: [],
    })

    const [pipeline] = result.workspacePipelines
    expect(pipeline?.primaryProject).toBeUndefined()
    expect(pipeline?.story).toBeUndefined()
    expect(pipeline?.mergeRequests).toEqual([])
    expect(pipeline?.crons).toEqual([])
  })
})
