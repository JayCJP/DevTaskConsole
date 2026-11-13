import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { jobSchema, type ChannelState, type Job, type Snapshot } from '@devtask/shared'
import { ApplicationMappingStore } from '../integrations/application-mappings.js'
import { DevOpsAdapter } from '../integrations/devops.js'
import { GitLabAdapter } from '../integrations/gitlab.js'
import { TapdAdapter } from '../integrations/tapd.js'
import { readLocalHarness } from './local-harness.js'
import { collectBranches, collectBuildRecords, collectMergeRequests } from './release-data.js'
import { CodeBuddyApi } from '../services/codebuddy-api.js'
import { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { CronMappingStore, readLocalCrons } from './cron-data.js'

const tapd = new TapdAdapter()
const gitLab = new GitLabAdapter()
const devOps = new DevOpsAdapter()
const applicationMappings = new ApplicationMappingStore()
const storyServiceSupervisor = new StoryServiceSupervisor()
const codeBuddyApi = new CodeBuddyApi()

export function getWorkspacesRoot(): string {
  if (process.env.DEVTASK_WORKSPACES_ROOT) return process.env.DEVTASK_WORKSPACES_ROOT
  return process.platform === 'win32' ? 'D:\\test-blanch' : join(homedir(), 'devtask-workspaces')
}

export async function buildSnapshot(workspacesRoot = getWorkspacesRoot()): Promise<Snapshot> {
  const snapshotAt = new Date().toISOString()
  const localResult = await readLocalHarness(workspacesRoot)
  const localRootAvailable = await directoryExists(workspacesRoot)
  const mappingResult = await loadApplicationMappings()
  const [tapdResult, gitlabResult, devopsResult, codeBuddyResult, cronResult] = await Promise.all([
    loadTapdSnapshot(snapshotAt, localResult.requirements),
    loadGitLabSnapshot(snapshotAt, workspacesRoot, localResult.requirements, mappingResult),
    loadDevOpsSnapshot(snapshotAt, mappingResult),
    loadCodeBuddySnapshot(snapshotAt, workspacesRoot, localResult.requirements),
    loadCronSnapshot(snapshotAt, workspacesRoot, localResult.requirements),
  ])
  const channels: Record<string, ChannelState> = {
    localHarness: {
      fetchedAt: snapshotAt,
      ok: localRootAvailable && localResult.errors.length === 0,
      stale: false,
      ...(!localRootAvailable
        ? { error: `Workspaces root is not available: ${workspacesRoot}` }
        : localResult.errors.length
          ? { error: localResult.errors.join(' ') }
          : {}),
    },
    tapd: tapdResult.channel,
    gitlab: gitlabResult.channel,
    devops: devopsResult.channel,
    codebuddy: codeBuddyResult.channel,
    crons: cronResult.channel,
  }

  const inbox: Snapshot['inbox'] = [
    ...localResult.requirements
      .filter((requirement) => requirement.status === 'blocked')
      .map((requirement) => ({
        id: `blocked:${requirement.storyId}`,
        kind: 'blocked_job' as const,
        title: requirement.title,
        reason: `Harness Story ${requirement.storyId} is marked blocked.`,
        requirementId: requirement.storyId,
        priority: 'high' as const,
      })),
    ...localResult.openQuestions
      .filter((question) => question.state === 'pending_confirmation' || question.state === 'no_proposal')
      .map((question) => ({
        id: `question:${question.storyId}:${question.id}`,
        kind: 'open_question' as const,
        title: question.question,
        reason: question.state === 'pending_confirmation' ? '待用户确认。' : '缺少建议稿，需要先补充分析。',
        requirementId: question.storyId,
        priority: 'high' as const,
        target: `/board?storyId=${encodeURIComponent(question.storyId)}`,
      })),
  ]

  return {
    snapshotAt,
    channels,
    requirements: tapdResult.requirements,
    bugs: tapdResult.bugs,
    harnessBugs: localResult.harnessBugs,
    openQuestions: localResult.openQuestions,
    harnessActive: localResult.harnessActive,
    inbox,
    jobs: codeBuddyResult.jobs,
    crons: cronResult.crons,
    builds: devopsResult.builds,
    branches: devopsResult.branches,
    mergeRequests: gitlabResult.mergeRequests,
  }
}

async function loadCronSnapshot(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
): Promise<{ channel: ChannelState; crons: Snapshot['crons'] }> {
  try {
    const mappings = await new CronMappingStore().list()
    const result = await readLocalCrons(workspacesRoot, requirements, mappings)
    return {
      channel: {
        fetchedAt,
        ok: result.errors.length === 0,
        stale: false,
        ...(result.errors.length ? { error: result.errors.join(' ') } : {}),
      },
      crons: result.crons,
    }
  } catch (error) {
    return {
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'Unable to load scheduled tasks.',
      },
      crons: [],
    }
  }
}

async function loadCodeBuddySnapshot(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
): Promise<{ channel: ChannelState; jobs: Job[] }> {
  const jobs: Job[] = []
  const errors: string[] = []
  try {
    const services = await storyServiceSupervisor.list()
    if (!services.length) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'No Story services have been started yet.' },
        jobs,
      }
    }
    for (const service of services) {
      const requirement = requirements.find((item) => item.storyId === service.storyId)
      if (!requirement?.workspacePath) {
        errors.push(`Story service ${service.storyId} has no associated workspace in the current snapshot.`)
        continue
      }
      const expectedCwd = resolve(workspacesRoot, requirement.workspacePath)
      const sameWorkspace = process.platform === 'win32'
        ? resolve(service.cwd).toLowerCase() === expectedCwd.toLowerCase()
        : resolve(service.cwd) === expectedCwd
      if (!sameWorkspace) {
        errors.push(`Story service ${service.storyId} workspace mapping no longer matches the snapshot.`)
        continue
      }
      const inspected = await storyServiceSupervisor.inspect(service.storyId)
      if (!inspected || inspected.status !== 'running') {
        errors.push(inspected?.error ?? `Story service ${service.storyId} is unavailable.`)
        continue
      }
      try {
        const query = new URLSearchParams({ all: '1', cwd: inspected.cwd })
        const result = await codeBuddyApi.request(inspected.port, `/api/v1/jobs?${query}`, 'GET')
        const parsed = jobSchema.array().safeParse(result)
        if (!parsed.success) throw new Error('CodeBuddy returned an invalid jobs response.')
        jobs.push(...parsed.data.map((job) => ({ ...job, storyId: service.storyId })))
      } catch (error) {
        errors.push(error instanceof Error ? `${service.storyId}: ${error.message}` : `${service.storyId}: job listing failed.`)
      }
    }
    return {
      channel: {
        fetchedAt,
        ok: errors.length === 0,
        stale: false,
        ...(errors.length ? { error: errors.join(' ') } : {}),
      },
      jobs,
    }
  } catch (error) {
    return {
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'CodeBuddy service registry could not be read.',
      },
      jobs,
    }
  }
}

async function loadApplicationMappings(): Promise<{
  mappings: Awaited<ReturnType<ApplicationMappingStore['list']>>
  error?: string
}> {
  try {
    return { mappings: await applicationMappings.list() }
  } catch (error) {
    return {
      mappings: [],
      error: error instanceof Error ? error.message : 'Application mapping data could not be read.',
    }
  }
}

async function loadGitLabSnapshot(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
  mappingResult: Awaited<ReturnType<typeof loadApplicationMappings>>,
): Promise<{ channel: ChannelState; mergeRequests: Snapshot['mergeRequests'] }> {
  try {
    if (mappingResult.error) throw new Error(`Application mappings are unavailable: ${mappingResult.error}`)
    const configured = await gitLab.checkConnection()
    if (!configured) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'GitLab is not configured.' },
        mergeRequests: [],
      }
    }
    const mergeRequests = await collectMergeRequests(
      requirements,
      mappingResult.mappings,
      workspacesRoot,
      gitLab,
    )
    return { channel: { fetchedAt, ok: true, stale: false }, mergeRequests }
  } catch (error) {
    return {
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'GitLab data request failed.',
      },
      mergeRequests: [],
    }
  }
}

async function loadDevOpsSnapshot(
  fetchedAt: string,
  mappingResult: Awaited<ReturnType<typeof loadApplicationMappings>>,
): Promise<{ channel: ChannelState; builds: Snapshot['builds']; branches: NonNullable<Snapshot['branches']> }> {
  try {
    if (mappingResult.error) throw new Error(`Application mappings are unavailable: ${mappingResult.error}`)
    const configured = await devOps.checkConnection()
    if (!configured) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'DevOps is not configured.' },
        builds: [],
        branches: [],
      }
    }
    const [builds, branches] = await Promise.all([
      collectBuildRecords(mappingResult.mappings, devOps),
      collectBranches(mappingResult.mappings, devOps),
    ])
    return { channel: { fetchedAt, ok: true, stale: false }, builds, branches }
  } catch (error) {
    return {
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'DevOps data request failed.',
      },
      builds: [],
      branches: [],
    }
  }
}

async function loadTapdSnapshot(
  fetchedAt: string,
  requirements: Snapshot['requirements'],
): Promise<{ channel: ChannelState; requirements: Snapshot['requirements']; bugs: Snapshot['bugs'] }> {
  try {
    const configured = await tapd.checkConnection()
    if (!configured) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'TAPD is not configured.' },
        requirements,
        bugs: [],
      }
    }
    const data = await tapd.aggregate(requirements)
    return {
      channel: { fetchedAt, ok: true, stale: false },
      requirements: data.requirements,
      bugs: data.bugs,
    }
  } catch (error) {
    return {
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'TAPD data request failed.',
      },
      requirements,
      bugs: [],
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
