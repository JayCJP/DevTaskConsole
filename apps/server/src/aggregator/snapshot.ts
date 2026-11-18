import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
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
import { DevOpsAdapter } from '../integrations/devops.js'
import { GitLabAdapter } from '../integrations/gitlab.js'
import { TapdAdapter, mergeTapdEnrichment } from '../integrations/tapd.js'
import { listWorkspaces } from '../workspaces/registry.js'
import { readLocalHarness } from './local-harness.js'
import { CodeBuddyApi } from '../services/codebuddy-api.js'
import { ScheduledTaskClient } from '../services/scheduled-tasks.js'
import { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { CronMappingStore, readLocalCrons } from './cron-data.js'
import { mergeCronFacts, type CronRealtimeSource } from './cron-merge.js'
import { buildWorkspacePipelines } from './workspace-pipelines.js'
import { SNAPSHOT_CACHE_VERSION, type LocalSegment, type SnapshotCacheFile, type TapdSegment } from './snapshot-cache.js'

const tapd = new TapdAdapter()
const gitLab = new GitLabAdapter()
const devOps = new DevOpsAdapter()
const storyServiceSupervisor = new StoryServiceSupervisor()
const codeBuddyApi = new CodeBuddyApi()
// 走 shell 执行以正确解析 PATH 中的 CLI（Windows 下 npm 全局命令多为无扩展名入口或 .cmd，
// execFile 直接 spawn 会 ENOENT）；命令与参数均为硬编码，无命令注入风险。
const execAsync = promisify(exec)
/** CodeBuddy CLI 安装引导地址，未安装时随通道状态返回给前端展示 */
const CODEBUDDY_INSTALL_URL = 'https://www.codebuddy.cn/docs/cli/quickstart'
/** runtime 段单次请求超时：实例不可达时把首屏等待封顶在 3s，不影响其它调用方的 30s 默认值 */
const RUNTIME_TIMEOUT_MS = 3_000
/** ScheduledTaskClient 内部调用不透传单次超时，用短超时实例保证 cron 链路同样封顶 */
const runtimeCronClient = new ScheduledTaskClient(new CodeBuddyApi(RUNTIME_TIMEOUT_MS))

/** 连通性 / viewer 内存缓存有效期：冷启动必拉一次，60s 内复用，手动刷新强制失效 */
const CONNECTIVITY_TTL_MS = 60_000
let connectivityMemory: { at: number; value: ConnectivitySegment } | undefined

/**
 * 标记缓存段的 stale 状态，返回新对象（不改动入参）。
 * 读取命中时置 true 如实反映数据来自缓存；写盘时置 false 保持缓存文件干净。
 * @param segment 缓存段（local 或 tapd）
 * @param stale 是否标记为陈旧
 * @returns 带新 stale 标记的段
 */
function markStale<T extends { channel: ChannelState }>(segment: T, stale: boolean): T {
  return { ...segment, channel: { ...segment.channel, stale } }
}

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

/** 不缓存的连通性与身份段 */
interface ConnectivitySegment {
  gitlab: ChannelState
  devops: ChannelState
  viewer?: ViewerIdentity
}

/** 不缓存的 runtime 段：来自运行中 Story 实例的 jobs 与定时任务 */
interface RuntimeSegment {
  codebuddyChannel: ChannelState
  cronsChannel: ChannelState
  jobs: Job[]
  crons: Snapshot['crons']
}

/** 快照构建参数 */
export interface SnapshotBuildOptions {
  /** 手动刷新：强制重建 local + tapd 两段并刷新连通性内存缓存 */
  force?: boolean
  /** 命中的本地段缓存；注入后跳过磁盘扫描 */
  cachedLocal?: LocalSegment
  /** 命中的 TAPD 段缓存；注入后跳过整个 TAPD 请求（含 checkConnection） */
  cachedTapd?: TapdSegment
}

/** 快照构建结果：快照本体 + 本次实际使用的段，供调用方写回磁盘缓存 */
export interface SnapshotBuildResult {
  snapshot: Snapshot
  segments: { local: LocalSegment; tapd: TapdSegment }
  /** 各段本次是否发生重建（决定是否需要写盘） */
  rebuilt: { local: boolean; tapd: boolean }
}

/**
 * 加载本地扫描段：工作区 story 文件与 workspace 列表。
 * 磁盘递归较慢但变更不频繁，是可缓存的慢段之一。
 * @param fetchedAt 快照时间
 * @param workspacesRoot 工作区根目录
 * @returns 本地段
 */
async function loadLocalSegment(fetchedAt: string, workspacesRoot: string): Promise<LocalSegment> {
  const [localResult, localRootAvailable, workspaceScan] = await Promise.all([
    readLocalHarness(workspacesRoot),
    directoryExists(workspacesRoot),
    loadWorkspaceScan(workspacesRoot),
  ])
  const localErrors = [...localResult.errors, ...(workspaceScan.error ? [workspaceScan.error] : [])]
  const channel: ChannelState = {
    fetchedAt,
    ok: localRootAvailable && localErrors.length === 0,
    stale: false,
    ...(!localRootAvailable
      ? { error: `Workspaces root is not available: ${workspacesRoot}` }
      : localErrors.length
        ? { error: localErrors.join(' ') }
        : {}),
  }
  return {
    fetchedAt,
    channel,
    requirements: localResult.requirements,
    harnessBugs: localResult.harnessBugs,
    openQuestions: localResult.openQuestions,
    harnessActive: localResult.harnessActive,
    workspaces: workspaceScan.workspaces,
    localRootAvailable,
  }
}

/**
 * 加载 TAPD 段：校验连通性后强制/复用拉取，导出原始增强字段而非整份需求数组。
 * 只存 TAPD 侧字段，重组时以本地需求为骨架叠加，避免本地新增/删除被旧数组覆盖。
 * @param fetchedAt 快照时间
 * @param requirements 本地需求骨架
 * @param force 是否强制穿透 TAPD 的 60s 内存缓存
 * @returns TAPD 段
 */
async function loadTapdSegment(
  fetchedAt: string,
  requirements: Snapshot['requirements'],
  force: boolean,
): Promise<TapdSegment> {
  const storyIds = [...new Set(requirements
    .filter((item): item is Requirement & { tapdStoryId: string } =>
      typeof item.tapdStoryId === 'string' && item.tapdStoryId.trim().length > 0)
    .map((item) => item.tapdStoryId))]
  // 通道健康只取决于 TAPD MCP 是否连接成功：
  // 只要 checkConnection() 通过，就视为「链接正常」，与后续能否取到数据无关。
  // 取数失败仅记日志，不再把通道标红——连接通但某次聚合偶发失败不等于链接异常。
  let configured: boolean
  try {
    configured = await tapd.checkConnection()
  } catch (error) {
    return {
      fetchedAt,
      channel: {
        fetchedAt,
        ok: false,
        stale: false,
        error: error instanceof Error ? error.message : 'TAPD MCP connection failed.',
      },
      enrichment: {},
    }
  }
  if (!configured) {
    return {
      fetchedAt,
      channel: { fetchedAt: null, ok: false, stale: false, error: 'TAPD is not configured.' },
      enrichment: {},
    }
  }

  // MCP 已连接：无论聚合是否成功，通道都标记为 ok。
  try {
    const data = await tapd.aggregate(requirements, { force })
    const raw = tapd.exportRawEnrichment(storyIds)
    const segmentAt = data.cachedAt ?? fetchedAt
    return {
      fetchedAt: segmentAt,
      // 复用内存缓存时如实回传缓存时间并标记 stale，避免把 60 秒前的数据说成刚拉取
      channel: { fetchedAt: segmentAt, ok: true, stale: data.cachedAt !== undefined },
      enrichment: Object.fromEntries(raw),
    }
  } catch (error) {
    // 取数失败不影响链接状态，仅记录服务端日志便于排查上游偶发问题
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[snapshot] TAPD MCP connected but aggregate failed: ${reason}`)
    return {
      fetchedAt,
      channel: { fetchedAt, ok: true, stale: false },
      enrichment: {},
    }
  }
}

/**
 * 加载 runtime 段：并发查询 jobs 与定时任务，不缓存、每次请求实时拉。
 * @param fetchedAt 快照时间
 * @param workspacesRoot 工作区根目录
 * @param requirements 本地需求
 * @param workspaces 工作区摘要
 * @returns runtime 段
 */
async function loadRuntimeSegment(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
  workspaces: WorkspaceSummary[],
): Promise<RuntimeSegment> {
  const [codeBuddyResult, cronResult] = await Promise.all([
    loadCodeBuddySnapshot(fetchedAt, workspacesRoot, requirements),
    loadCronSnapshot(fetchedAt, workspacesRoot, requirements, workspaces),
  ])
  return {
    codebuddyChannel: codeBuddyResult.channel,
    cronsChannel: cronResult.channel,
    jobs: codeBuddyResult.jobs,
    crons: cronResult.crons,
  }
}

/**
 * 加载连通性与 viewer 段，60s 内存缓存；手动刷新强制刷新。
 * GitLab/DevOps 的 checkConnection 是远端 HTTP（10s/30s），不能每次首屏都打。
 * @param fetchedAt 快照时间
 * @param force 是否强制刷新内存缓存
 * @returns 连通性段
 */
async function loadConnectivitySegment(fetchedAt: string, force: boolean): Promise<ConnectivitySegment> {
  const now = Date.now()
  if (!force && connectivityMemory && now - connectivityMemory.at < CONNECTIVITY_TTL_MS) {
    return connectivityMemory.value
  }
  const [gitlab, devops, viewer] = await Promise.all([
    checkGitLabConnection(fetchedAt),
    checkDevOpsConnection(fetchedAt),
    loadViewerIdentity(),
  ])
  const value: ConnectivitySegment = { gitlab, devops, ...(viewer ? { viewer } : {}) }
  connectivityMemory = { at: now, value }
  return value
}

/**
 * 纯组装：把 local / tapd / runtime / 连通性四段合成最终快照，不触达任何数据源。
 * TAPD 增强字段按 tapdStoryId 叠加到本地需求骨架上，与 `mergeTapdEnrichment` 共用语义。
 * @param params 四段与快照时间
 * @returns 最终快照
 */
function assembleSnapshot(params: {
  workspacesRoot: string
  snapshotAt: string
  local: LocalSegment
  tapd: TapdSegment
  runtime: RuntimeSegment
  connectivity: ConnectivitySegment
}): Snapshot {
  const { workspacesRoot, snapshotAt, local, tapd, runtime, connectivity } = params
  const merged = mergeTapdEnrichment(local.requirements, new Map(Object.entries(tapd.enrichment)))
  const channels: Record<string, ChannelState> = {
    localHarness: local.channel,
    tapd: tapd.channel,
    gitlab: connectivity.gitlab,
    devops: connectivity.devops,
    codebuddy: runtime.codebuddyChannel,
    crons: runtime.cronsChannel,
  }

  // 流水线先算出来：收件箱与看板/流水线必须共用同一份 Story 识别结果，不能各算一套
  const pipelines = buildWorkspacePipelines({
    workspacesRoot,
    workspaces: local.workspaces,
    requirements: merged.requirements,
    harnessActive: local.harnessActive,
    crons: runtime.crons,
    jobs: runtime.jobs,
  })
  const inbox = buildInbox(pipelines.workspacePipelines, {
    requirements: local.requirements,
    openQuestions: local.openQuestions,
  })

  return {
    snapshotAt,
    ...(connectivity.viewer ? { viewer: connectivity.viewer } : {}),
    channels,
    requirements: merged.requirements,
    bugs: merged.bugs,
    harnessBugs: local.harnessBugs,
    openQuestions: local.openQuestions,
    harnessActive: local.harnessActive,
    inbox,
    jobs: runtime.jobs,
    crons: runtime.crons,
    ...pipelines,
  }
}

/**
 * 构建快照并返回本次实际使用的段。
 *
 * local / tapd 命中缓存时直接复用（stale 标 true），否则重建；runtime 与连通性每次实时/走内存缓存。
 * TAPD 强制重建失败但旧缓存可用时保留旧段，只更新 local 段。
 *
 * @param workspacesRoot 工作区根目录
 * @param options 构建参数
 * @returns 快照构建结果
 */
export async function buildSnapshotResult(
  workspacesRoot = getWorkspacesRoot(),
  options: SnapshotBuildOptions = {},
): Promise<SnapshotBuildResult> {
  const snapshotAt = new Date().toISOString()
  const force = options.force === true

  let local: LocalSegment
  let localRebuilt = false
  if (!force && options.cachedLocal) {
    // 缓存命中：如实标记 stale，fetchedAt 保留原抓取时间
    local = markStale(options.cachedLocal, true)
  } else {
    local = await loadLocalSegment(snapshotAt, workspacesRoot)
    localRebuilt = true
  }

  let tapd: TapdSegment
  let tapdRebuilt = false
  if (!force && options.cachedTapd) {
    tapd = markStale(options.cachedTapd, true)
  } else {
    const fresh = await loadTapdSegment(snapshotAt, local.requirements, force)
    if (!fresh.channel.ok && options.cachedTapd) {
      // force 重建失败但旧缓存可用：保留旧 TAPD 段，只更新 local 段（评审 Q12）
      tapd = markStale(options.cachedTapd, true)
    } else {
      tapd = fresh
      tapdRebuilt = true
    }
  }

  const [runtime, connectivity] = await Promise.all([
    loadRuntimeSegment(snapshotAt, workspacesRoot, local.requirements, local.workspaces),
    loadConnectivitySegment(snapshotAt, force),
  ])

  const snapshot = assembleSnapshot({ workspacesRoot, snapshotAt, local, tapd, runtime, connectivity })
  return {
    snapshot,
    segments: { local, tapd },
    rebuilt: { local: localRebuilt, tapd: tapdRebuilt },
  }
}

/**
 * 构建控制台统一快照（对外兼容入口）。
 * @param workspacesRoot 工作区根目录
 * @param options 构建参数
 * @returns 快照
 */
export async function buildSnapshot(
  workspacesRoot = getWorkspacesRoot(),
  options: SnapshotBuildOptions = {},
): Promise<Snapshot> {
  return (await buildSnapshotResult(workspacesRoot, options)).snapshot
}

/** 缓存存储的最小接口，便于测试注入内存替身 */
export interface SnapshotCacheStore {
  read(workspacesRoot: string): SnapshotCacheFile | undefined
  write(entry: SnapshotCacheFile): Promise<void>
}

/**
 * 构造带磁盘缓存的快照 provider：普通请求命中 local+tapd 缓存直返，force 强制重建并写盘。
 * runtime 与连通性不经过此缓存——它们由 `buildSnapshotResult` 每次实时/走内存缓存。
 *
 * @param options.workspacesRoot 工作区根目录
 * @param options.cache 缓存存储（默认由调用方注入 SnapshotCache）
 * @param options.build 快照构建器，测试可注入替身
 * @param options.logError 写盘失败时的日志回调
 * @returns 带缓存的 provider，接收 force 参数
 */
export function createCachedSnapshotProvider(options: {
  workspacesRoot: string
  cache: SnapshotCacheStore
  build?: (root: string, buildOptions: SnapshotBuildOptions) => Promise<SnapshotBuildResult>
  logError?: (message: string) => void
}): (force?: boolean) => Promise<Snapshot> {
  const build = options.build ?? buildSnapshotResult
  return async (force = false) => {
    // force 时也读缓存：TAPD 强拉失败要保留旧段（Q12）
    const cached = options.cache.read(options.workspacesRoot)
    const result = await build(options.workspacesRoot, {
      force,
      cachedLocal: cached?.segments.local,
      cachedTapd: cached?.segments.tapd,
    })
    if (force || !cached || result.rebuilt.local || result.rebuilt.tapd) {
      try {
        await options.cache.write({
          version: SNAPSHOT_CACHE_VERSION,
          snapshotAt: result.snapshot.snapshotAt,
          workspacesRoot: options.workspacesRoot,
          // stale 是读取时的派生标记，写盘时复位，保持缓存文件干净
          segments: {
            local: markStale(result.segments.local, false),
            tapd: markStale(result.segments.tapd, false),
          },
        })
      } catch (error) {
        // 缓存是加速手段，写盘失败不阻断刷新，只记日志（评审 Q3）
        options.logError?.(`Failed to write snapshot cache: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return result.snapshot
  }
}

/** 定时任务事实：只含本地文件、工作区扫描与本地服务实时数据，不触达 TAPD/GitLab/DevOps */
export interface CronFacts {
  fetchedAt: string
  channel: ChannelState
  crons: Snapshot['crons']
  /** 本地 Harness 需求（用于 Story 与工作区归属，不含 TAPD 增强字段） */
  requirements: Snapshot['requirements']
  workspaces: WorkspaceSummary[]
}

/**
 * 只构建定时任务所需的事实，跳过 TAPD/GitLab/DevOps/CodeBuddy 聚合。
 *
 * 定时任务的归属、工作区定位与 session 绑定都来自本地文件与本地服务，
 * 与 TAPD 数据无关；cron 路由若为此构建整份快照，每次操作都会顺带打一次
 * TAPD（2~4 个请求），既慢又容易触发上游限流。
 *
 * @param workspacesRoot 工作区根目录
 * @returns 定时任务事实（含通道状态）
 */
export async function buildCronFacts(workspacesRoot = getWorkspacesRoot()): Promise<CronFacts> {
  const fetchedAt = new Date().toISOString()
  const [localResult, workspaceScan] = await Promise.all([
    readLocalHarness(workspacesRoot),
    loadWorkspaceScan(workspacesRoot),
  ])
  const cronResult = await loadCronSnapshot(
    fetchedAt,
    workspacesRoot,
    localResult.requirements,
    workspaceScan.workspaces,
  )
  return {
    fetchedAt,
    channel: cronResult.channel,
    crons: cronResult.crons,
    requirements: localResult.requirements,
    workspaces: workspaceScan.workspaces,
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
 * 并发查询所有服务并用短超时封顶；单个 Story 失败只记录原因并跳过，不影响其它 Story。
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
      const sessionId = await runtimeCronClient.resolveSessionId(
        inspected.port,
        inspected.cwd,
        bound?.ownerSessionId ?? bound?.sessionId,
      )
      const tasks = await runtimeCronClient.list(inspected.port, { sessionId })
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

/**
 * 检测本机 CodeBuddy CLI 是否已安装，并用 `codebuddy --version` 取版本号。
 *
 * 通道健康只取决于 CLI 是否安装：能取到版本即视为已安装（ok=true），
 * 取不到则视为未安装（ok=false），与 Story 服务/jobs 是否可用无关。
 * 版本或安装提示统一放在 `error` 字段中承载，避免扩展 ChannelState 结构。
 *
 * @param fetchedAt 快照时间
 * @returns codebuddy 通道状态
 */
async function detectCodeBuddyChannel(fetchedAt: string): Promise<ChannelState> {
  try {
    const { stdout } = await execAsync('codebuddy --version', { timeout: RUNTIME_TIMEOUT_MS })
    const version = stdout.trim().split('\n')[0]?.trim()
    if (version) {
      return { fetchedAt, ok: true, stale: false, error: `codebuddy ${version}` }
    }
  } catch {
    // 命令不存在或执行失败，按未安装处理
  }
  return {
    fetchedAt,
    ok: false,
    stale: false,
    error: `未安装 CodeBuddy CLI，请访问 ${CODEBUDDY_INSTALL_URL} 安装`,
  }
}

/**
 * 从运行中的 Story 服务并发拉取 jobs；单服务失败只记原因，不影响其它服务。
 * 通道状态由本机 CodeBuddy CLI 是否安装决定，与 jobs 拉取结果解耦。
 * @param fetchedAt 快照时间
 * @param workspacesRoot 工作区根目录
 * @param requirements 本地需求
 * @returns 通道状态与 jobs
 */
async function loadCodeBuddySnapshot(
  fetchedAt: string,
  workspacesRoot: string,
  requirements: Snapshot['requirements'],
): Promise<{ channel: ChannelState; jobs: Job[] }> {
  // 通道状态只看 CLI 是否安装，与后续 jobs 拉取是否成功无关
  const channel = await detectCodeBuddyChannel(fetchedAt)
  try {
    const services = await storyServiceSupervisor.list()
    if (!services.length) {
      return { channel, jobs: [] }
    }
    // 并发拉取所有服务，单服务耗时不再累加；短超时实例把最坏等待封顶在 3s
    const results = await Promise.all(services.map(async (service) => {
      const requirement = requirements.find((item) => item.storyId === service.storyId)
      if (!requirement?.workspacePath) {
        return { jobs: [] as Job[], error: `Story service ${service.storyId} has no associated workspace in the current snapshot.` }
      }
      const expectedCwd = resolve(workspacesRoot, requirement.workspacePath)
      const isSameWorkspace = process.platform === 'win32'
        ? resolve(service.cwd).toLowerCase() === expectedCwd.toLowerCase()
        : resolve(service.cwd) === expectedCwd
      if (!isSameWorkspace) {
        return { jobs: [] as Job[], error: `Story service ${service.storyId} workspace mapping no longer matches the snapshot.` }
      }
      const inspected = await storyServiceSupervisor.inspect(service.storyId)
      if (!inspected || inspected.status !== 'running') {
        return { jobs: [] as Job[], error: inspected?.error ?? `Story service ${service.storyId} is unavailable.` }
      }
      try {
        const query = new URLSearchParams({ all: '1', cwd: inspected.cwd })
        // 显式传单次超时（方案 §3.8）：runtime 链路封顶 3s，不影响其它 30s 调用方
        const result = await codeBuddyApi.request(inspected.port, `/api/v1/jobs?${query}`, 'GET', undefined, RUNTIME_TIMEOUT_MS)
        const parsed = jobSchema.array().safeParse(result)
        if (!parsed.success) throw new Error('CodeBuddy returned an invalid jobs response.')
        return { jobs: parsed.data.map((job) => ({ ...job, storyId: service.storyId })) as Job[], error: undefined }
      } catch (error) {
        return {
          jobs: [] as Job[],
          error: error instanceof Error ? `${service.storyId}: ${error.message}` : `${service.storyId}: job listing failed.`,
        }
      }
    }))
    const jobs = results.flatMap((result) => result.jobs)
    // jobs 拉取的失败原因仅记录日志，不再作为「CLI 是否安装」的判定依据
    const errors = results.flatMap((result) => result.error ? [result.error] : [])
    if (errors.length) {
      console.error(`[snapshot] CodeBuddy jobs listing partial failures: ${errors.join(' ')}`)
    }
    return { channel, jobs }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[snapshot] CodeBuddy jobs listing failed: ${reason}`)
    return { channel, jobs: [] }
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

/**
 * 探测 GitLab 连通性：只做配置/令牌可用性检查，不拉取合并请求数据。
 * 合并请求已从首屏快照移除，设置页仍需据此展示通道是否连通。
 * @param fetchedAt 快照时间
 * @returns 通道状态
 */
async function checkGitLabConnection(fetchedAt: string): Promise<ChannelState> {
  try {
    const configured = await gitLab.checkConnection()
    return configured
      ? { fetchedAt, ok: true, stale: false }
      : { fetchedAt: null, ok: false, stale: false, error: 'GitLab is not configured.' }
  } catch (error) {
    return {
      fetchedAt,
      ok: false,
      stale: false,
      error: error instanceof Error ? error.message : 'GitLab connection check failed.',
    }
  }
}

/**
 * 探测 DevOps 连通性：只做登录会话可用性检查，不拉取构建/分支数据。
 * 构建与分支已从首屏快照移除，设置页仍需据此展示通道是否连通。
 * @param fetchedAt 快照时间
 * @returns 通道状态
 */
async function checkDevOpsConnection(fetchedAt: string): Promise<ChannelState> {
  try {
    const configured = await devOps.checkConnection()
    return configured
      ? { fetchedAt, ok: true, stale: false }
      : { fetchedAt: null, ok: false, stale: false, error: 'DevOps is not configured.' }
  } catch (error) {
    return {
      fetchedAt,
      ok: false,
      stale: false,
      error: error instanceof Error ? error.message : 'DevOps connection check failed.',
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
