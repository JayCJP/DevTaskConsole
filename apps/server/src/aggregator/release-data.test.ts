import { describe, expect, it, vi } from 'vitest'
import { defaultDevOpsGroup } from '@devtask/shared'
import {
  expandApplicationIdentities,
  isDefaultApplicationMapping,
  type ApplicationIdentity,
} from '../integrations/application-mappings.js'
import { collectBranches, collectBuildRecords, collectMergeRequests } from './release-data.js'

/**
 * 构造默认身份（仓库名 == DevOps 应用名）。
 * @param repoName 仓库名
 * @returns 默认身份
 */
function defaultIdentity(repoName: string): ApplicationIdentity {
  return {
    repoName,
    devopsApp: repoName,
    devopsGroup: defaultDevOpsGroup,
    explicit: false,
  }
}

describe('release data collection', () => {
  it('queries the mapped GitLab project for the worktree branch', async () => {
    const listMergeRequests = vi.fn(async (_projectId: number, sourceBranch: string) => [{
      projectId: 99,
      id: '42',
      title: 'Feature MR',
      sourceBranch,
      targetBranch: 'dev',
      state: 'opened',
    }, {
      projectId: 99,
      id: '43',
      title: 'Unrelated target',
      sourceBranch,
      targetBranch: 'main',
      state: 'opened',
    }])

    const result = await collectMergeRequests(
      [{ repoName: 'repo-a', branch: 'feature/custom', storyIds: ['HARNESS-1'] }],
      [{ ...defaultIdentity('repo-a'), gitlabProjectId: 99, explicit: true }],
      { listMergeRequests },
    )

    expect(listMergeRequests).toHaveBeenCalledTimes(1)
    expect(listMergeRequests).toHaveBeenCalledWith(99, 'feature/custom')
    expect(result.errors).toEqual([])
    expect(result.items).toEqual([{
      projectId: 99,
      id: '42',
      title: 'Feature MR',
      sourceBranch: 'feature/custom',
      targetBranch: 'dev',
      state: 'opened',
      storyId: 'HARNESS-1',
    }])
  })

  it('falls back to an exact GitLab project name match without storing it', async () => {
    const listMergeRequests = vi.fn(async (projectId: number, sourceBranch: string) => [{
      projectId,
      id: '7',
      title: 'Default mapping MR',
      sourceBranch,
      targetBranch: 'dev',
      state: 'opened',
    }])
    const findProjects = vi.fn(async () => [
      { id: 11, pathWithNamespace: 'group/CustomerServiceSystem' },
      { id: 12, pathWithNamespace: 'group/CustomerServiceSystem-admin' },
    ])

    const result = await collectMergeRequests(
      [
        { repoName: 'CustomerServiceSystem', branch: 'feat/x', storyIds: ['STORY-1'] },
        { repoName: 'livepage', branch: 'feat/x', storyIds: ['STORY-1'] },
      ],
      [defaultIdentity('CustomerServiceSystem'), defaultIdentity('livepage')],
      { listMergeRequests, findProjects },
    )

    expect(findProjects).toHaveBeenCalledWith('CustomerServiceSystem')
    expect(listMergeRequests).toHaveBeenCalledTimes(1)
    expect(listMergeRequests).toHaveBeenCalledWith(11, 'feat/x')
    expect(result.items).toEqual([expect.objectContaining({ projectId: 11, storyId: 'STORY-1' })])
  })

  it('skips projects without a branch or without an unambiguous GitLab match', async () => {
    const listMergeRequests = vi.fn(async () => [])

    await expect(collectMergeRequests(
      [{ repoName: 'repo-a', storyIds: ['STORY-1'] }],
      [defaultIdentity('repo-a')],
      { listMergeRequests, findProjects: async () => [
        { id: 1, pathWithNamespace: 'group/repo-a' },
        { id: 2, pathWithNamespace: 'other/repo-a' },
      ] },
    )).resolves.toEqual({ items: [], errors: [] })

    await expect(collectMergeRequests(
      [{ repoName: 'repo-b', branch: 'feat/x', storyIds: ['STORY-1'] }],
      [defaultIdentity('repo-b')],
      { listMergeRequests, findProjects: async () => [] },
    )).resolves.toEqual({ items: [], errors: [] })
    expect(listMergeRequests).not.toHaveBeenCalled()
  })

  it('keeps other projects when one GitLab project query fails', async () => {
    const listMergeRequests = vi.fn(async (projectId: number, sourceBranch: string) => {
      if (projectId === 1) throw new Error('GitLab request failed with HTTP 500.')
      return [{
        projectId,
        id: '8',
        title: 'Healthy MR',
        sourceBranch,
        targetBranch: 'dev',
        state: 'opened',
      }]
    })

    const result = await collectMergeRequests(
      [
        { repoName: 'broken', branch: 'feat/x', storyIds: ['STORY-1'] },
        { repoName: 'healthy', branch: 'feat/x', storyIds: ['STORY-1'] },
      ],
      [
        { ...defaultIdentity('broken'), gitlabProjectId: 1, explicit: true },
        { ...defaultIdentity('healthy'), gitlabProjectId: 2, explicit: true },
      ],
      { listMergeRequests },
    )

    expect(result.items).toEqual([expect.objectContaining({ projectId: 2, storyId: 'STORY-1' })])
    expect(result.errors).toEqual(['GitLab 项目 1 的 MR 查询失败：GitLab request failed with HTTP 500.'])
  })

  it('fetches each unique DevOps application once, defaulting to the repository name', async () => {
    const getBuildRecords = vi.fn(async (app: string) => [{
      id: '1',
      app,
      succeed: true,
    }])

    const result = await collectBuildRecords(
      [defaultIdentity('repo-a'), defaultIdentity('repo-a'), defaultIdentity('repo-b')],
      { getBuildRecords },
    )

    expect(getBuildRecords).toHaveBeenCalledTimes(2)
    expect(getBuildRecords).toHaveBeenCalledWith('repo-a', 1, 20)
    expect(getBuildRecords).toHaveBeenCalledWith('repo-b', 1, 20)
    expect(result.items).toEqual([
      { id: '1', app: 'repo-a', succeed: true, group: defaultDevOpsGroup },
      { id: '1', app: 'repo-b', succeed: true, group: defaultDevOpsGroup },
    ])
    expect(result.errors).toEqual([])
  })

  it('reports a failing DevOps application without dropping the healthy ones', async () => {
    const getBuildRecords = vi.fn(async (app: string) => {
      if (app === 'broken') throw new Error('DevOps request failed with HTTP 500.')
      return [{ id: '2', app, succeed: true }]
    })

    const result = await collectBuildRecords(
      [defaultIdentity('broken'), defaultIdentity('healthy')],
      { getBuildRecords },
    )

    expect(result.items).toEqual([
      { id: '2', app: 'healthy', succeed: true, group: defaultDevOpsGroup },
    ])
    expect(result.errors).toEqual(['DevOps 应用 broken 的构建记录查询失败：DevOps request failed with HTTP 500.'])
  })

  it('fetches branches once per unique application mapping', async () => {
    const getBranches = vi.fn(async (app: string, group?: string) => [{
      app,
      ...(group ? { group } : {}),
      name: 'origin/dev',
      commitId: 'abc123',
    }])

    await expect(collectBranches(
      [
        { repoName: 'repo-a', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb', explicit: true },
        { repoName: 'repo-b', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb', explicit: true },
      ],
      { getBranches },
    )).resolves.toEqual({
      items: [{
        app: 'Frontend',
        group: 'JenkinsFrontweb',
        name: 'origin/dev',
        commitId: 'abc123',
      }],
      errors: [],
    })
    expect(getBranches).toHaveBeenCalledTimes(1)
  })
})

describe('application identity expansion', () => {
  it('defaults to the repository name and only applies explicit differences', () => {
    const identities = expandApplicationIdentities(
      ['repo-a', 'repo-b', 'repo-a'],
      [{ repoName: 'repo-b', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' }],
    )

    expect(identities).toEqual([
      { repoName: 'repo-a', devopsApp: 'repo-a', devopsGroup: defaultDevOpsGroup, explicit: false },
      { repoName: 'repo-b', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb', explicit: true },
    ])
  })

  it('treats an identical-name mapping as the default identity', () => {
    expect(isDefaultApplicationMapping({ repoName: 'repo-a', devopsApp: 'repo-a', devopsGroup: defaultDevOpsGroup }))
      .toBe(true)
    expect(isDefaultApplicationMapping({ repoName: 'repo-a', devopsApp: 'repo-a' })).toBe(false)
    expect(isDefaultApplicationMapping({ repoName: 'repo-a', gitlabProjectId: 5 })).toBe(false)
  })
})
