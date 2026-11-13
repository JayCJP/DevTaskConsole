import { execFile } from 'node:child_process'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  ApplicationMapping,
  Branch,
  Build,
  MergeRequest,
  Requirement,
} from '@devtask/shared'
import type { DevOpsAdapter } from '../integrations/devops.js'
import type { GitLabAdapter } from '../integrations/gitlab.js'

const execFileAsync = promisify(execFile)

export async function collectMergeRequests(
  requirements: Requirement[],
  mappings: ApplicationMapping[],
  workspacesRoot: string,
  gitlab: Pick<GitLabAdapter, 'listMergeRequests'>,
  resolveBranch: (cwd: string) => Promise<string> = getCurrentBranch,
): Promise<MergeRequest[]> {
  const projectIds = new Map<string, number>()
  for (const mapping of mappings) {
    if (mapping.gitlabProjectId !== undefined) projectIds.set(mapping.repoName, mapping.gitlabProjectId)
  }
  const requests = new Map<string, { projectId: number; sourceBranch: string; storyIds: Set<string> }>()
  for (const requirement of requirements) {
    if (!requirement.workspacePath) continue
    const cwd = resolve(workspacesRoot, requirement.workspacePath)
    assertInsideRoot(workspacesRoot, cwd)
    const repoName = basename(cwd)
    const projectId = projectIds.get(repoName)
    if (projectId === undefined) continue
    const sourceBranch = await resolveBranch(cwd)
    if (!sourceBranch) throw new Error(`Unable to determine the Git branch for ${requirement.workspacePath}.`)
    const key = `${projectId}:${sourceBranch}`
    const request = requests.get(key) ?? { projectId, sourceBranch, storyIds: new Set<string>() }
    request.storyIds.add(requirement.storyId)
    requests.set(key, request)
  }

  const batches = await Promise.all([...requests.values()].map(async (request) => {
    const mergeRequests = await gitlab.listMergeRequests(request.projectId, request.sourceBranch)
    return mergeRequests
      .filter((mergeRequest) => mergeRequest.targetBranch === 'dev')
      .flatMap((mergeRequest) => [...request.storyIds].map((storyId) => ({ ...mergeRequest, storyId })))
  }))
  return batches.flat()
}

export async function collectBuildRecords(
  mappings: ApplicationMapping[],
  devops: Pick<DevOpsAdapter, 'getBuildRecords'>,
): Promise<Build[]> {
  const uniqueMappings = new Map<string, { app: string; group: string }>()
  for (const mapping of mappings) {
    if (!mapping.devopsApp || !mapping.devopsGroup) continue
    uniqueMappings.set(`${mapping.devopsGroup}:${mapping.devopsApp}`, {
      app: mapping.devopsApp,
      group: mapping.devopsGroup,
    })
  }
  const batches = await Promise.all([...uniqueMappings.values()].map(async ({ app, group }) =>
    (await devops.getBuildRecords(app, 1, 20)).map((build) => ({ ...build, group }))))
  return batches.flat()
}

export async function collectBranches(
  mappings: ApplicationMapping[],
  devops: Pick<DevOpsAdapter, 'getBranches'>,
): Promise<Branch[]> {
  const uniqueMappings = new Map<string, { app: string; group: string }>()
  for (const mapping of mappings) {
    if (!mapping.devopsApp || !mapping.devopsGroup) continue
    uniqueMappings.set(`${mapping.devopsGroup}:${mapping.devopsApp}`, {
      app: mapping.devopsApp,
      group: mapping.devopsGroup,
    })
  }
  const batches = await Promise.all([...uniqueMappings.values()].map(({ app, group }) =>
    devops.getBranches(app, group)))
  return batches.flat()
}

async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
    })
    return stdout.trim()
  } catch (error) {
    throw new Error(`Unable to read the current branch in ${cwd}.`, { cause: error })
  }
}

function assertInsideRoot(root: string, candidate: string): void {
  const fromRoot = relative(resolve(root), resolve(candidate))
  if (isAbsolute(fromRoot) || fromRoot.split(/[\\/]/, 1)[0] === '..') {
    throw new Error('Workspace path resolves outside the configured workspaces root.')
  }
}
