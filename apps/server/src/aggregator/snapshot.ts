import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  jobSchema,
  type ChannelState,
  type Job,
  type Requirement,
  type Snapshot,
  type ViewerIdentity,
  type WorkspaceSummary,
} from '@devtask/shared'
import {
  ApplicationMappingStore,
  expandApplicationIdentities,
  type ApplicationIdentity,
} from '../integrations/application-mappings.js'
import { DevOpsAdapter } from '../integrations/devops.js'
import { GitLabAdapter } from '../integrations/gitlab.js'
import { TapdAdapter } from '../integrations/tapd.js'
import { listWorkspaces } from '../workspaces/registry.js'
import { readLocalHarness } from './local-harness.js'
import {
  collectBranches,
  collectBuildRecords,
  collectMergeRequests,
  type ReleaseProjectTarget,
} from './release-data.js'
import { CodeBuddyApi } from '../services/codebuddy-api.js'
import { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { CronMappingStore, readLocalCrons } from './cron-data.js'
import { buildWorkspacePipelines } from './workspace-pipelines.js'

const tapd = new TapdAdapter()
const gitLab = new GitLabAdapter()
const devOps = new DevOpsAdapter()
const applicationMappings = new ApplicationMappingStore()
const storyServiceSupervisor = new StoryServiceSupervisor()
const codeBuddyApi = new CodeBuddyApi()

/**
 * 解析工作区扫描根目录。
 * 优先级：显式环境变量 → Windows 下的 D:\test-branch（新工作区目录）→ 历史目录 D:\test-blanch。
 * @returns 工作区扫描根目录绝对路径
 */
export function getWorkspacesRoot(): string {
  if (process.env.DEVTASK_WORKSPACES_ROOT) return process.env.DEVTASK_WORKSPACES_ROOT
  if (process.platform === 'win32') {
    return existsSync('D:\\test-branch') ? 'D:\\test-branch' : 'D:\\test-blanch'
  }
  return join(homedir(), 'devtask-workspaces')
}

export async function buildSnapshot(workspacesRoot = getWorkspacesRoot()): Promise<Snapshot> {
  const snapshotAt = new Date().toISOString()
  const localResult = await readLocalHarness(workspacesRoot)
  const localRootAvailable = await directoryExists(workspacesRoot)
  const mappingResult = await loadApplicationMappings()
  const workspaceScan = await loadWorkspaceScan(workspacesRoot)
  // 默认约定“仓库名 == DevOps 应用名”，只有名称不同的项目才有差异映射
  const identities = expandApplicationIdentities(
    [
      ...workspaceScan.workspaces.flatMap((workspace) => workspace.projects.map((project) => project.name)),
      ...mappingResult.mappings.map((mapping) => mapping.repoName),
    ],
    mappingResult.mappings,
  )
  const releaseTargets = buildReleaseTargets(localResult.requirements, workspaceScan.workspaces, workspacesRoot)
  const localErrors = [...localResult.errors, ...(workspaceScan.error ? [workspaceScan.error] : [])]
  const [tapdResult, gitlabResult, devopsResult, codeBuddyResult, cronResult, viewer] = await Promise.all([
    loadTapdSnapshot(snapshotAt, localResult.requirements),
    loadGitLabSnapshot(snapshotAt, releaseTargets, identities),
    loadDevOpsSnapshot(snapshotAt, identities),
    loadCodeBuddySnapshot(snapshotAt, workspacesRoot, localResult.requirements),
    loadCronSnapshot(snapshotAt, workspacesRoot, localResult.requirements, workspaceScan.workspaces),
    loadViewerIdentity(),
  ])
  const channels: Record<string, ChannelState> = {
    localHarness: {
      fetchedAt: snapshotAt,
      ok: localRootAvailable && localErrors.length === 0,
      stale: false,
      ...(!localRootAvailable
        ? { error: `Workspaces root is not available: ${workspacesRoot}` }
        : localErrors.length
          ? { error: localErrors.join(' ') }
          : {}),
    },
    tapd: tapdResult.channel,
    gitlab: gitlabResult.channel,
    devops: devopsResult.channel,
    codebuddy: codeBuddyResult.channel,
    crons: cronResult.channel,
  }

  // Story → 工作区相对路径：收件箱的每类事项都要带上工作区，前端才能按「工作区 → Story」分组
  const workspaceByStory = new Map(
    localResult.requirements.map((requirement) => [requirement.storyId, requirement.workspacePath]),
  )
  const inbox: Snapshot['inbox'] = [
    ...localResult.requirements
      .filter((requirement) => requirement.status === 'blocked')
      .map((requirement) => ({
        id: `blocked:${requirement.storyId}`,
        kind: 'blocked_job' as const,
        title: requirement.title,
        reason: `Harness Story ${requirement.storyId} is marked blocked.`,
        requirementId: requirement.storyId,
        ...(requirement.workspacePath ? { workspacePath: requirement.workspacePath } : {}),
        priority: 'high' as const,
      })),
    ...localResult.openQuestions
      .filter((question) => question.state === 'pending_confirmation' || question.state === 'no_proposal')
      .map((question) => {
        const workspacePath = workspaceByStory.get(question.storyId)
        return {
          id: `question:${question.storyId}:${question.id}`,
          kind: 'open_question' as const,
          title: question.question,
          reason: question.state === 'pending_confirmation' ? '待用户确认。' : '缺少建议稿，需要先补充分析。',
          requirementId: question.storyId,
          ...(workspacePath ? { workspacePath } : {}),
          priority: 'high' as const,
          target: `/board?storyId=${encodeURIComponent(question.storyId)}`,
        }
      }),
  ]

  return {
    snapshotAt,
    ...(viewer ? { viewer } : {}),
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
    // 流水线以工作区为根：工作区 → 项目 → Story，前端不需要再自行拼装层级
    ...buildWorkspacePipelines({
      workspacesRoot,
      workspaces: workspaceScan.workspaces,
      requirements: tapdResult.requirements,
      harnessActive: localResult.harnessActive,
      mergeRequests: gitlabResult.mergeRequests,
      builds: devopsResult.builds,
      branches: devopsResult.branches,
      crons: cronResult.crons,
      jobs: codeBuddyResult.jobs,
    }),
  }
}

async function loadCronSnapshot(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
  workspaces: WorkspaceSummary[],
): Promise<{ channel: ChannelState; crons: Snapshot['crons'] }> {
  try {
    const mappings = await new CronMappingStore().list()
    // 定时任务以工作区为根：先扫工作区项目目录，再补上 Story 目录，避免数据源与页面结构不一致
    const result = await readLocalCrons(workspacesRoot, requirements, mappings, workspaces)
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

/**
 * 识别当前查看者在外部系统中的身份，供发布页“只看我的”筛选。
 * GitLab 取访问令牌对应用户名，DevOps 取当前登录账号；任一失败只缺省该字段，不阻塞快照。
 * @returns 身份信息；两项都识别失败时返回 undefined
 */
async function loadViewerIdentity(): Promise<ViewerIdentity | undefined> {
  const [gitlabUser, devopsOperator] = await Promise.all([
    gitLab.getCurrentUser().catch(() => null),
    devOps.getLoginUser().catch(() => null),
  ])
  const viewer: ViewerIdentity = {
    ...(gitlabUser?.username ? { gitlabUsername: gitlabUser.username } : {}),
    ...(devopsOperator ? { devopsOperator } : {}),
  }
  return viewer.gitlabUsername || viewer.devopsOperator ? viewer : undefined
}

async function loadGitLabSnapshot(
  fetchedAt: string,
  targets: ReleaseProjectTarget[],
  identities: ApplicationIdentity[],
): Promise<{ channel: ChannelState; mergeRequests: Snapshot['mergeRequests'] }> {
  try {
    const configured = await gitLab.checkConnection()
    if (!configured) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'GitLab is not configured.' },
        mergeRequests: [],
      }
    }
    const outcome = await collectMergeRequests(targets, identities, gitLab)
    return {
      channel: {
        fetchedAt,
        // 部分项目失败仍算通道可用，失败原因单独透出，避免一票否决
        ok: outcome.items.length > 0 || outcome.errors.length === 0,
        stale: false,
        ...(outcome.errors.length ? { error: outcome.errors.join(' ') } : {}),
      },
      mergeRequests: outcome.items,
    }
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
  identities: ApplicationIdentity[],
): Promise<{ channel: ChannelState; builds: Snapshot['builds']; branches: NonNullable<Snapshot['branches']> }> {
  try {
    const configured = await devOps.checkConnection()
    if (!configured) {
      return {
        channel: { fetchedAt: null, ok: false, stale: false, error: 'DevOps is not configured.' },
        builds: [],
        branches: [],
      }
    }
    const [buildOutcome, branchOutcome] = await Promise.all([
      collectBuildRecords(identities, devOps),
      collectBranches(identities, devOps),
    ])
    const errors = [...buildOutcome.errors, ...branchOutcome.errors]
    return {
      channel: {
        fetchedAt,
        // 单个应用查询失败时仍展示其它应用的数据，只在全部失败时标记通道不可用
        ok: buildOutcome.items.length + branchOutcome.items.length > 0 || errors.length === 0,
        stale: false,
        ...(errors.length ? { error: errors.join(' ') } : {}),
      },
      builds: buildOutcome.items,
      branches: branchOutcome.items,
    }
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

/**
 * 扫描工作区（*.code-workspace），失败时返回空列表与错误信息。
 * @param workspacesRoot 工作区根目录
 * @returns 工作区摘要与错误信息
 */
async function loadWorkspaceScan(
  workspacesRoot: string,
): Promise<{ workspaces: WorkspaceSummary[]; error?: string }> {
  try {
    return { workspaces: await listWorkspaces(workspacesRoot) }
  } catch (error) {
    return {
      workspaces: [],
      error: error instanceof Error ? error.message : 'Workspace scan failed.',
    }
  }
}

/**
 * 把工作区第一个项目转换成发布链路查询目标。
 * 与流水线视图保持一致：一个工作区只查它 `folders[0]` 项目的 MR，
 * Story 必须是位于该项目目录下的需求，避免把工作区名当成仓库名去查。
 * @param requirements 本地 Harness 需求
 * @param workspaces 工作区摘要
 * @returns 项目目标列表（仅保留第一个项目下有 Story 的工作区）
 */
function buildReleaseTargets(
  requirements: Requirement[],
  workspaces: WorkspaceSummary[],
  workspacesRoot: string,
): ReleaseProjectTarget[] {
  const targets: ReleaseProjectTarget[] = []
  for (const workspace of workspaces) {
    const primary = workspace.projects[0]
    if (!primary) continue
    const storyIds = requirements
      .filter((requirement) => requirementInDirectory(requirement, primary.path, workspacesRoot))
      .map((requirement) => requirement.storyId)
    if (!storyIds.length) continue
    targets.push({
      repoName: primary.name,
      ...(primary.branch ? { branch: primary.branch } : {}),
      storyIds: [...new Set(storyIds)],
    })
  }
  return targets
}

/**
 * 判断需求是否就位于给定项目目录（与流水线视图的识别规则保持一致）。
 * @param requirement 本地 Harness 需求
 * @param projectPath 项目目录绝对路径
 * @param workspacesRoot 工作区扫描根目录
 * @returns 是否同一目录；需求缺少工作区路径时返回 false
 */
function requirementInDirectory(
  requirement: Requirement,
  projectPath: string,
  workspacesRoot: string,
): boolean {
  if (!requirement.workspacePath) return false
  const directory = isAbsolute(requirement.workspacePath)
    ? resolve(requirement.workspacePath)
    : resolve(workspacesRoot, requirement.workspacePath)
  const normalize = (path: string): string => {
    const normalized = resolve(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(directory) === normalize(projectPath)
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
