import { describe, expect, it, vi } from 'vitest'
import type { ApplicationMapping, Requirement } from '@devtask/shared'
import { collectBranches, collectBuildRecords, collectMergeRequests } from './release-data.js'

describe('mapped release data', () => {
  it('uses explicit repository-to-project mappings and the worktree branch', async () => {
    const root = 'C:\\workspaces'
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
    const requirements: Requirement[] = [
      { storyId: 'HARNESS-1', title: 'First', workspacePath: 'work-one\\repo-a' },
      { storyId: 'HARNESS-2', title: 'Unmapped', workspacePath: 'work-two\\repo-b' },
    ]
    const mappings: ApplicationMapping[] = [{ repoName: 'repo-a', gitlabProjectId: 99 }]

    const result = await collectMergeRequests(
      requirements,
      mappings,
      root,
      { listMergeRequests },
      async (cwd) => cwd.endsWith('repo-a') ? 'feature/custom' : '',
    )

    expect(listMergeRequests).toHaveBeenCalledTimes(1)
    expect(listMergeRequests).toHaveBeenCalledWith(99, 'feature/custom')
    expect(result).toEqual([{
      projectId: 99,
      id: '42',
      title: 'Feature MR',
      sourceBranch: 'feature/custom',
      targetBranch: 'dev',
      state: 'opened',
      storyId: 'HARNESS-1',
    }])
  })

  it('rejects a workspace path outside the configured root', async () => {
    await expect(collectMergeRequests(
      [{ storyId: 'HARNESS-1', title: 'First', workspacePath: '..\\outside\\repo-a' }],
      [{ repoName: 'repo-a', gitlabProjectId: 99 }],
      'C:\\workspaces',
      { listMergeRequests: vi.fn() },
      async () => 'feature/branch',
    )).rejects.toThrow('outside the configured workspaces root')
  })

  it('fetches each unique DevOps app/group mapping once', async () => {
    const getBuildRecords = vi.fn(async (app: string) => [{
      id: '1',
      app,
      succeed: true,
    }])
    const mappings: ApplicationMapping[] = [
      { repoName: 'repo-a', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' },
      { repoName: 'repo-b', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' },
    ]

    const result = await collectBuildRecords(mappings, { getBuildRecords })

    expect(getBuildRecords).toHaveBeenCalledTimes(1)
    expect(result).toEqual([{ id: '1', app: 'Frontend', succeed: true, group: 'JenkinsFrontweb' }])
  })

  it('fetches branches once per unique application mapping', async () => {
    const getBranches = vi.fn(async (app: string, group?: string) => [{
      app,
      ...(group ? { group } : {}),
      name: 'origin/dev',
      commitId: 'abc123',
    }])
    const mappings: ApplicationMapping[] = [
      { repoName: 'repo-a', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' },
      { repoName: 'repo-b', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' },
    ]

    await expect(collectBranches(mappings, { getBranches })).resolves.toEqual([{
      app: 'Frontend',
      group: 'JenkinsFrontweb',
      name: 'origin/dev',
      commitId: 'abc123',
    }])
    expect(getBranches).toHaveBeenCalledTimes(1)
  })
})
