import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  jobSchema,
  type ChannelState,
  type InboxItem,
  type Job,
  type OpenQuestion,
  type Requirement,
  type Snapshot,
  type ViewerIdentity,
  type WorkspacePipeline,
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
import { ScheduledTaskClient } from '../services/scheduled-tasks.js'
import { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { CronMappingStore, readLocalCrons } from './cron-data.js'
import { mergeCronFacts, type CronRealtimeSource } from './cron-merge.js'
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

  // 流水线先算出来：收件箱与看板/流水线必须共用同一份 Story 识别结果，不能各算一套
  const pipelines = buildWorkspacePipelines({
    workspacesRoot,
    workspaces: workspaceScan.workspaces,
    requirements: tapdResult.requirements,
    harnessActive: localResult.harnessActive,
    mergeRequests: gitlabResult.mergeRequests,
    builds: devopsResult.builds,
    branches: devopsResult.branches,
    crons: cronResult.crons,
    jobs: codeBuddyResult.jobs,
  })
  const inbox = buildInbox(pipelines.workspacePipelines, localResult)

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
    ...pipelines,
  }
}

/**
 * 由工作区流水线派生收件箱事项。
 *
 * 提取顺序照搬工作区视图：先按工作区列表走，每个工作区只认一个 Story
 * （`folders[0]` 项目的 `.codebuddy/plans`），再看这个 Story 有没有待决策事项。
 * 没有被任何工作区认领的 Story 不进收件箱——它在工作区视图里也不存在，
 * 收进来只会造成「收了却在别处看不到」的错位。
 *
 * 注意：`blocked` 只来自本地 `e2e-state.json`，不能读流水线里被 TAPD 覆盖过的 `status`。
 *
 * @param pipelines 工作区流水线（已按文件夹声明顺序选好每个工作区的唯一 Story）
 * @param facts 本地 Harness 只读事实（需求状态与待确认项）
 * @returns 收件箱事项，每条都带上所属工作区
 */
function buildInbox(
  pipelines: WorkspacePipeline[],
  facts: { requirements: Requirement[]; openQuestions: OpenQuestion[] },
): Snapshot['inbox'] {
  /** Story → 本地运行期需求（status 未被 TAPD 覆盖，blocked 只认这里） */
  const localByStory = new Map(facts.requirements.map((requirement) => [requirement.storyId, requirement]))
  /** Story → 待人工确认的 open question */
  const questionsByStory = new Map<string, OpenQuestion[]>()
  for (const question of facts.openQuestions) {
    if (question.state !== 'pending_confirmation' && question.state !== 'no_proposal') continue
    const bucket = questionsByStory.get(question.storyId)
    if (bucket) bucket.push(question)
    else questionsByStory.set(question.storyId, [question])
  }

  const inbox: Snapshot['inbox'] = []
  for (const pipeline of pipelines) {
    const requirement = pipeline.story?.requirement
    if (!requirement) continue
    const local = localByStory.get(requirement.storyId)
    const workspacePath = requirement.workspacePath ?? local?.workspacePath
    const ownership: Pick<InboxItem, 'workspaceName' | 'workspacePath'> = {
      workspaceName: pipeline.name,
      ...(workspacePath ? { workspacePath } : {}),
    }

    if (local?.status === 'blocked') {
      inbox.push({
        id: `blocked:${requirement.storyId}`,
        kind: 'blocked_job',
        title: local.title || requirement.title,
        reason: `Harness Story ${requirement.storyId} is marked blocked.`,
        requirementId: requirement.storyId,
        ...ownership,
        priority: 'high',
      })
    }

    for (const question of questionsByStory.get(requirement.storyId) ?? []) {
      inbox.push({
        id: `question:${requirement.storyId}:${question.id}`,
        kind: 'open_question',
        title: question.question,
        reason: question.state === 'pending_confirmation' ? '待用户确认。' : '缺少建议稿，需要先补充分析。',
        requirementId: requirement.storyId,
        ...ownership,
        priority: 'high',
        target: `/board?storyId=${encodeURIComponent(requirement.storyId)}`,
      })
    }
  }
  return inbox
}

/**
 * 读取定时任务快照：本地文件提供归属与工作区定位，运行中实例提供实时运行期事实。
 * 两边都拿不到时回退本地结果，并在通道状态里如实标注错误。
 * @param fetchedAt 快照时间
 * @param workspacesRoot 工作区根目录
 * @param requirements 本地 Harness 需求
 * @param workspaces 工作区摘要
 * @returns 通道状态与合并后的任务列表
 */
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
    // 本地文件可能落后于实例（例如刚创建/刚启停），用实时数据覆盖运行期字段
    const realtime = await loadRealtimeCrons(requirements, workspacesRoot, result.crons)
    const errors = [...result.errors, ...realtime.errors]
    return {
      channel: {
        fetchedAt,
        ok: errors.length === 0,
        stale: false,
        ...(errors.length ? { error: errors.join(' ') } : {}),
      },
      crons: mergeCronFacts(result.crons, realtime.sources, mappings),
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

/**
 * 从运行中的 Story 服务读取实时定时任务。
 * 单个 Story 失败只记录原因并跳过，不影响其它 Story 的数据。
 * @param requirements 本地 Harness 需求
 * @param workspacesRoot 工作区根目录，用于核对服务 cwd 与 Story 归属是否仍然一致
 * @param localCrons 本地任务事实，提供已保存的 session 绑定
 * @returns 实时来源列表与错误信息
 */
async function loadRealtimeCrons(
  requirements: Snapshot['requirements'],
  workspacesRoot: string,
  localCrons: Snapshot['crons'],
): Promise<{ sources: CronRealtimeSource[]; errors: string[] }> {
  const sources: CronRealtimeSource[] = []
  const errors: string[] = []
  let services
  try {
    services = await storyServiceSupervisor.list()
  } catch (error) {
    return {
      sources,
      errors: [error instanceof Error ? error.message : 'Story service registry could not be read.'],
    }
  }
  const client = new ScheduledTaskClient(codeBuddyApi)
  await Promise.all(services.map(async (service) => {
    if (service.status !== 'running') return
    const inspected = await storyServiceSupervisor.inspect(service.storyId)
    if (!inspected || inspected.status !== 'running') {
      errors.push(inspected?.error ?? `Story service ${service.storyId} is unavailable.`)
      return
    }
    const workspacePath = requirements.find((item) => item.storyId === service.storyId)?.workspacePath
    if (workspacePath && !sameWorkspace(inspected.cwd, resolve(workspacesRoot, workspacePath))) {
      errors.push(`Story service ${service.storyId} workspace mapping no longer matches the snapshot.`)
      return
    }
    try {
      const bound = localCrons.find((cron) => (
        cron.storyId === service.storyId && (cron.ownerSessionId || cron.sessionId)
      ))
      const sessionId = await client.resolveSessionId(
        inspected.port,
        inspected.cwd,
        bound?.ownerSessionId ?? bound?.sessionId,
      )
      const tasks = await client.list(inspected.port, { sessionId })
      sources.push({
        storyId: service.storyId,
        ...(workspacePath ? { workspacePath } : {}),
        tasks,
      })
    } catch (error) {
      errors.push(error instanceof Error ? `${service.storyId}: ${error.message}` : `${service.storyId}: task listing failed.`)
    }
  }))
  return { sources, errors }
}

/**
 * 比较两个目录是否指向同一工作区；Windows 下大小写不敏感。
 * @param left 实际目录
 * @param right 期望目录
 * @returns 相同返回 true
 */
function sameWorkspace(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
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
