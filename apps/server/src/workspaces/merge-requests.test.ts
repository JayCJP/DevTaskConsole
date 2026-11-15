import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDevOpsGroup, type ApplicationMapping } from '@devtask/shared'
import type { GitLabMergeRequest, GitLabMergeRequestCreateInput } from '../integrations/gitlab.js'
import { createWorkspaceMergeRequests, type WorkspaceMergeRequestDeps } from './merge-requests.js'
import { WorkspaceNotFoundError } from './registry.js'

let workspacesRoot: string | undefined

afterEach(async () => {
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  workspacesRoot = undefined
})

/**
 * 构造一个最小工作区：两个 git 项目，均检出 feat/feature-x 分支。
 * @param root 工作区根目录
 * @returns 工作区根目录（供断言使用）
 */
async function createWorkspaceFixture(root: string): Promise<string> {
  const workspacePath = join(root, 'feature-x')
  for (const project of ['repo-a', 'repo-b']) {
    await mkdir(join(workspacePath, project, '.git'), { recursive: true })
    await writeFile(join(workspacePath, project, '.git', 'HEAD'), 'ref: refs/heads/feat/feature-x\n', 'utf8')
  }
  await writeFile(
    join(workspacePath, 'feature-x.code-workspace'),
    JSON.stringify({ folders: [{ path: 'repo-a' }, { path: 'repo-b' }] }),
    'utf8',
  )
  return root
}

/**
 * 创建 GitLab 桩实现，默认对每个仓库名返回唯一同名项目。
 * @param overrides 需要覆盖的方法行为
 * @returns 可注入的依赖集合，同时保留 vi 断言句柄
 */
function createDeps(overrides: {
  gitlab?: Partial<WorkspaceMergeRequestDeps['gitlab']>
  mappings?: ApplicationMapping[]
} = {}): WorkspaceMergeRequestDeps {
  return {
    gitlab: {
      findProjects: vi.fn(async (search: string) => [{ id: search === 'repo-a' ? 11 : 12, pathWithNamespace: `group/${search}` }]),
      listMergeRequests: vi.fn(async (): Promise<GitLabMergeRequest[]> => []),
      createMergeRequest: vi.fn(async (projectId: number, input: GitLabMergeRequestCreateInput): Promise<GitLabMergeRequest> => ({
        projectId,
        id: '7',
        title: input.title,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'opened',
        webUrl: `https://gitlab.example/group/repo/-/merge_requests/7`,
      })),
      ...overrides.gitlab,
    },
    mappings: { list: async () => overrides.mappings ?? [] },
  }
}

describe('workspace merge request creation', () => {
  it('creates one merge request per project against the requested base branch', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)
    const deps = createDeps({
      // repo-b 使用人工映射，repo-a 走仓库名精确匹配
      mappings: [{ repoName: 'repo-b', devopsApp: 'repo-b', devopsGroup: defaultDevOpsGroup, gitlabProjectId: 22 }],
    })

    const result = await createWorkspaceMergeRequests(root, 'feature-x', { targetBranch: 'test' }, deps)

    expect(result).toMatchObject({ workspace: 'feature-x', targetBranch: 'test' })
    expect(result.items).toEqual([
      expect.objectContaining({ project: 'repo-a', sourceBranch: 'feat/feature-x', status: 'created', gitlabProjectId: 11 }),
      expect.objectContaining({ project: 'repo-b', sourceBranch: 'feat/feature-x', status: 'created', gitlabProjectId: 22 }),
    ])
    expect(deps.gitlab.findProjects).toHaveBeenCalledTimes(1)
    expect(deps.gitlab.findProjects).toHaveBeenCalledWith('repo-a')
    expect(deps.gitlab.createMergeRequest).toHaveBeenCalledTimes(2)
    expect(deps.gitlab.createMergeRequest).toHaveBeenCalledWith(22, expect.objectContaining({
      sourceBranch: 'feat/feature-x',
      targetBranch: 'test',
    }))
  })

  it('returns the existing merge request instead of creating a duplicate', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)
    const deps = createDeps({
      gitlab: {
        listMergeRequests: vi.fn(async (projectId: number, sourceBranch: string): Promise<GitLabMergeRequest[]> => [{
          projectId,
          id: '42',
          title: 'existing',
          sourceBranch,
          targetBranch: 'test',
          state: 'opened',
          webUrl: 'https://gitlab.example/group/repo/-/merge_requests/42',
        }]),
      },
    })

    const result = await createWorkspaceMergeRequests(root, 'feature-x', { targetBranch: 'test' }, deps)

    expect(result.items.every((item) => item.status === 'exists')).toBe(true)
    expect(result.items[0]).toMatchObject({ mergeRequestIid: '42', webUrl: 'https://gitlab.example/group/repo/-/merge_requests/42' })
    expect(deps.gitlab.createMergeRequest).not.toHaveBeenCalled()
  })

  it('only handles the requested projects and reports unknown names individually', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)
    const deps = createDeps()

    const result = await createWorkspaceMergeRequests(
      root,
      'feature-x',
      { targetBranch: 'pre', projects: ['repo-b', 'repo-missing'] },
      deps,
    )

    expect(result.items).toEqual([
      expect.objectContaining({ project: 'repo-b', status: 'created', targetBranch: 'pre' }),
      expect.objectContaining({ project: 'repo-missing', status: 'failed' }),
    ])
    expect(deps.gitlab.createMergeRequest).toHaveBeenCalledTimes(1)
  })

  it('fails projects that cannot be matched to a unique GitLab project', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)
    const deps = createDeps({
      gitlab: {
        findProjects: vi.fn(async () => [
          { id: 1, pathWithNamespace: 'group/repo-a' },
          { id: 2, pathWithNamespace: 'other/repo-a' },
        ]),
      },
    })

    const result = await createWorkspaceMergeRequests(root, 'feature-x', { targetBranch: 'master' }, deps)

    expect(result.items.every((item) => item.status === 'failed')).toBe(true)
    expect(result.items[0]?.message).toContain('源系统映射')
    expect(deps.gitlab.createMergeRequest).not.toHaveBeenCalled()
  })

  it('keeps other projects when one GitLab call fails', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)
    const deps = createDeps({
      gitlab: {
        createMergeRequest: vi.fn(async (projectId: number, input: GitLabMergeRequestCreateInput): Promise<GitLabMergeRequest> => {
          if (projectId === 11) throw new Error('GitLab request failed with HTTP 400. Source branch does not exist')
          return {
            projectId,
            id: '9',
            title: input.title,
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
            state: 'opened',
          }
        }),
      },
    })

    const result = await createWorkspaceMergeRequests(root, 'feature-x', { targetBranch: 'prod-txnj' }, deps)

    expect(result.items).toEqual([
      expect.objectContaining({ project: 'repo-a', status: 'failed' }),
      expect.objectContaining({ project: 'repo-b', status: 'created' }),
    ])
    expect(result.items[0]?.message).toContain('HTTP 400')
  })

  it('rejects an unknown workspace', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-mr-'))
    const root = await createWorkspaceFixture(workspacesRoot)

    await expect(createWorkspaceMergeRequests(root, 'missing', { targetBranch: 'test' }, createDeps()))
      .rejects.toBeInstanceOf(WorkspaceNotFoundError)
  })
})
