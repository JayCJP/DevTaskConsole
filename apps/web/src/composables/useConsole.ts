/**
 * 控制台核心状态与行为（组合式函数）。
 * 由 ConsoleShell 在路由父级调用一次并通过 provide 共享，避免单组件巨石化。
 * 保留自 ConsolePage.vue 的全部逻辑，未改动任何业务语义。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  applicationMappingSchema,
  buildEnvironmentSpecs,
  buildTriggerResultSchema,
  defaultDevOpsGroup,
  type BuildEnvironment,
  type BuildEnvironmentSpec,
  defaultMergeRequestTargetBranch,
  defaultTapdWorkspaceId,
  jobSchema,
  mergeRequestTargetBranches,
  repositoryCandidateSchema,
  resumableSessionSchema,
  workspaceDeleteResultSchema,
  workspaceInitializationJobSchema,
  workspaceMergeRequestCreateResultSchema,
  workspacePreviewSchema,
  workspaceSummarySchema,
  type Requirement,
  type ApplicationMapping,
  type BoardStory,
  type Cron,
  type CronMode,
  type InboxItem,
  type Job,
  type MergeRequestTargetBranch,
  type RepositoryCandidate,
  type WorkspaceDeleteResult,
  type WorkspaceInitializationJob,
  type WorkspaceMergeRequestCreateItem,
  type WorkspaceMergeRequestCreateResult,
  type WorkspacePipeline,
  type WorkspacePreview,
  type WorkspaceSummary,
} from '@devtask/shared'
import { z } from 'zod'
import { useRoute, useRouter } from 'vue-router'
import type { UploadFile } from 'element-plus'
import { ApiError, apiRequest } from '../api/client'
import { useAuditTrail } from '../composables/useAuditTrail'
import { useBoardStories } from '../composables/useBoardStories'
import { useCronActions } from '../composables/useCronActions'
import { useCronDispatches, type DispatchOutcome } from '../composables/useCronDispatches'
import { useCronExecutions } from '../composables/useCronExecutions'
import { useActionToasts } from '../composables/useActionToasts'
import { buildInboxAnswerText, splitSuggestion, useInboxAnswers } from '../composables/useInboxAnswers'
import { useJobExtras } from '../composables/useJobExtras'
import { useServiceLifecycle, type StoryServiceInfo } from '../composables/useServiceLifecycle'
import { useStoryUpload, type UploadedAsset } from '../composables/useStoryUpload'
import { useConsoleStore } from '../stores/console'
import { buildMappingRows } from '../utils/application-mapping'

export function useConsole() {

/* ------------------------- 共享基础：路由、快照、抽屉、刷新分发 ------------------------- */

const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
/** 看板：TAPD 需求 × 本地工作区绑定 */
const board = reactive(useBoardStories())
const selectedRequirement = ref<Requirement | null>(null)
const selectedBugs = computed(() => store.snapshot?.bugs.filter((bug) => bug.storyId === selectedRequirement.value?.storyId) ?? [])
const selectedHarnessBugs = computed(() => store.snapshot?.harnessBugs.filter((bug) => bug.storyId === selectedRequirement.value?.storyId) ?? [])
const selectedQuestions = computed(() => store.snapshot?.openQuestions.filter((question) => question.storyId === selectedRequirement.value?.storyId) ?? [])
const tapdAvailable = computed(() => store.snapshot?.channels.tapd?.ok ?? false)
/** 快照是否已至少加载过一次；模板通过它区分「尚未加载」与「加载完成但无数据」 */
const snapshotLoaded = computed(() => store.loaded)
/** 快照请求进行中标记（模板内不直接读 store 的 ref 属性） */
const snapshotLoading = computed(() => store.loading)

/**
 * 触发一次快照刷新，供模板按钮调用。
 * @param force 是否跳过服务端 TAPD 增强字段缓存（手动刷新/重新检测时传 true）
 * @returns Promise<void>
 */
async function refreshSnapshot(force = false): Promise<void> {
  await store.refresh(force)
}

/**
 * 按段刷新快照：只重建指定段，其余段复用服务端缓存。
 * pipeline / inbox 的数据来自 local 段与 runtime 段，传 ['local'] 即可刷新它们而避开 TAPD/连通性。
 * @param segments 需要重建的段，如 ['local']
 * @returns Promise<void>
 */
async function refreshSegments(segments: Array<'local' | 'tapd'>): Promise<void> {
  await store.refreshSegments(segments)
}

/**
 * 刷新当前路由页面的数据——「来自哪里就刷新哪里」。
 * 各页数据源不同：pipeline/inbox 只需 local 段；其它页复用各自的独立接口；tools 需重检测连通性。
 * @returns Promise<void>
 */
async function refreshCurrentPage(): Promise<void> {
  const current = page.value
  if (current === 'inbox' || current === 'pipeline') {
    // 两页核心数据均由 local 段（工作区扫描/harness）生成，runtime 段每次请求实时拉
    await refreshSegments(['local'])
    return
  }
  if (current === 'board') {
    await board.load(true)
    return
  }
  if (current === 'workspaces') {
    await Promise.all([refreshWorkspaces(), refreshRepositoryCandidates()])
    return
  }
  if (current === 'instances') {
    await refreshStoryServices()
    return
  }
  if (current === 'crons') {
    await cronDispatches.refresh()
    return
  }
  if (current === 'releases') {
    await prepareReleasePage()
    return
  }
  if (current === 'tools') {
    await refreshSnapshot(true)
  }
}
const gitLabProjectSchema = z.object({ id: z.number().int().positive(), pathWithNamespace: z.string() })

const detailOpen = computed({
  get: () => selectedRequirement.value !== null,
  set: (open: boolean) => {
    if (!open) selectedRequirement.value = null
  },
})
const search = ref('')
/* ------------------------- 工作区 / 映射：表单状态与列表快照 ------------------------- */

const repositoryCandidates = ref<RepositoryCandidate[]>([])
const selectedRepositoryNames = ref<string[]>([])
/** 已保存的差异映射：服务端只返回与默认约定不一致、经人工确认的记录 */
const applicationMappings = ref<ApplicationMapping[]>([])
/** GitLab 项目候选项，仅用于人工选择 */
type MappingProjectOption = { id: number; pathWithNamespace: string }
/** 映射表单弹窗开关 */
const mappingDialogOpen = ref(false)
/** 正在编辑的仓库名；null 表示新增 */
const mappingEditingRepo = ref<string | null>(null)
/** 新增与编辑共用的表单草稿，留空字段表示沿用默认 */
const mappingForm = ref({
  repoName: '',
  gitlabProjectId: undefined as number | undefined,
  devopsApp: '',
  devopsGroup: '',
})
/** GitLab 搜索结果只作候选，不会自动采用 */
const mappingProjectOptions = ref<MappingProjectOption[]>([])
const mappingProjectsLoading = ref(false)
const mappingFormError = ref('')
const mappingSaving = ref(false)
/** 正在「恢复默认」的仓库名 */
const mappingRemoving = ref('')
const candidatesLoading = ref(false)
const candidatesError = ref('')
const mappingsError = ref('')

/**
 * 列表数据 = 一份默认规则 + 人工确认的差异映射。
 * 同名的仓库不产生数据行，未变动的字段折叠为「沿用默认」，只突出变动项。
 */
const mappingRows = computed(() => buildMappingRows(applicationMappings.value))

/** 新增映射时可选的仓库：扫描到的候选中排除已有差异映射的仓库 */
const mappingRepoOptions = computed(() => {
  const mapped = new Set(applicationMappings.value.map((mapping) => mapping.repoName))
  return repositoryCandidates.value.map((candidate) => candidate.name).filter((name) => !mapped.has(name))
})

/** 弹窗标题：编辑时带仓库名，便于确认操作对象 */
const mappingDialogTitle = computed(() => mappingEditingRepo.value ? `编辑映射 · ${mappingEditingRepo.value}` : '新增映射')

/**
 * 表单是否偏离默认约定。与默认一致时无需落盘，避免生成无意义的记录。
 */
const mappingFormChanged = computed(() => {
  const form = mappingForm.value
  const repoName = form.repoName.trim()
  return typeof form.gitlabProjectId === 'number'
    || (form.devopsApp.trim() !== '' && form.devopsApp.trim() !== repoName)
    || (form.devopsGroup.trim() !== '' && form.devopsGroup.trim() !== defaultDevOpsGroup)
})

/** 是否允许提交映射表单 */
const canSubmitMappingForm = computed(() =>
  mappingForm.value.repoName.trim().length > 0 && mappingFormChanged.value && !mappingSaving.value)

/** 扫描完成但没有候选仓库时才提示，避免与加载态、错误态叠加 */
const showNoRepositoryHint = computed(() =>
  !candidatesLoading.value && repositoryCandidates.value.length === 0 && !candidatesError.value)
const workspaceName = ref('')
const branch = ref('')
const baseBranch = ref('')
const skipInstall = ref(false)
const skipGraphify = ref(false)
/** 新建工作区时可选绑定的 TAPD 需求链接（或纯数字 ID）；留空表示不绑定 */
const workspaceTapdInput = ref('')
/** 新建工作区时可选的需求名称，TAPD 查询不到时用于展示 */
const workspaceTapdTitle = ref('')
/** 本轮工作区创建待写入的绑定；目标工作区名在提交时快照，避免轮询回调期间被新 job 覆盖 */
let pendingWorkspaceBinding: { tapdStoryId: string; storyTitle: string; workspaceName: string } | null = null
const previewResult = ref<WorkspacePreview | null>(null)
const workspaceJob = ref<WorkspaceInitializationJob | null>(null)
const workspaceError = ref('')

/* ------------------------- 工作区管理（列表 / 详情 / 删除） ------------------------- */

/** 删除工作区时必须逐字输入的确认文案 */
const deleteConfirmationPhrase = '确认删除'
/** 工作区列表数据，来自 GET /api/v1/workspaces */
const workspaces = ref<WorkspaceSummary[]>([])
const workspacesLoading = ref(false)
const workspacesError = ref('')
/** 详情抽屉当前展示的工作区 */
const selectedWorkspace = ref<WorkspaceSummary | null>(null)
/** 新建工作区弹窗开关 */
const createDialogOpen = ref(false)
/** 删除确认弹窗开关 */
const deleteDialogOpen = ref(false)
/** 待删除的工作区 */
const workspacePendingDelete = ref<WorkspaceSummary | null>(null)
/** 删除确认输入框内容 */
const deleteConfirmText = ref('')
const deleting = ref(false)
const deleteError = ref('')
const deleteResult = ref<WorkspaceDeleteResult | null>(null)
/** 工作区创建 MR 使用的目标分支，默认 test */
const mrTargetBranch = ref<MergeRequestTargetBranch>(defaultMergeRequestTargetBranch)
/** 正在创建 MR 的项目名，用于逐个按钮的 loading 态 */
const mrCreatingProjects = ref<string[]>([])
/** 一键创建（工作区全部项目）是否进行中 */
const mrBatchRunning = ref(false)
/** 最近一次创建 MR 的逐项目结果 */
const workspaceMergeRequestResult = ref<WorkspaceMergeRequestCreateResult | null>(null)
/** 创建 MR 的错误提示（整批请求失败或存在失败项目） */
const workspaceMergeRequestError = ref('')
/** 有任一创建任务在跑时禁用所有创建入口，避免重复提交 */
const mrBusy = computed(() => mrBatchRunning.value || mrCreatingProjects.value.length > 0)
/**
 * 取创建结果状态对应的展示文案。
 * @param status 单项目的创建结果状态
 * @returns 中文状态文案
 */
function mergeRequestStatusLabel(status: WorkspaceMergeRequestCreateItem['status']): string {
  return { created: '已创建', exists: '已存在', failed: '失败' }[status]
}

/**
 * 取创建结果状态对应的标签样式类。
 * @param status 单项目的创建结果状态
 * @returns 标签样式类名
 */
function mergeRequestStatusClass(status: WorkspaceMergeRequestCreateItem['status']): string {
  return { created: 'tag-success', exists: 'tag-warning', failed: 'tag-danger' }[status]
}

/**
 * 详情抽屉的 v-model 双向绑定。
 * 关闭时清空当前选中工作区，保证再次点击同一行也能正常打开。
 */
const workspaceDetailOpen = computed({
  get: () => selectedWorkspace.value !== null,
  set: (open: boolean) => {
    if (!open) selectedWorkspace.value = null
  },
})

/** 删除按钮是否可用：必须完整输入确认文案 */
const canConfirmDelete = computed(() => deleteConfirmText.value.trim() === deleteConfirmationPhrase)

/** 新建弹窗中的进度日志（DryRun 或真实初始化任务） */
const workspaceLogs = computed(() => workspaceJob.value?.logs ?? previewResult.value?.logs ?? [])

/** 新建弹窗是否仍有初始化任务在跑 */
const workspaceRunning = computed(() => workspaceJob.value?.status === 'running')
/**
 * 创建/续跑请求是否正在提交（POST /initialize 飞行中）。
 * 这段窗口内 workspaceJob 尚未赋值、workspaceRunning 仍为 false，
 * 必须单独禁用按钮与关闭操作，否则用户连点会并发创建多个工作区并让轮询互相干扰。
 */
const workspaceSubmitting = ref(false)
/** 新建弹窗整体忙碌态：覆盖提交中与任务运行中，供按钮禁用与 loading 使用 */
const workspaceBusy = computed(() => workspaceSubmitting.value || workspaceRunning.value)

/** 已选项目数量的展示文案 */
const selectedRepositoryLabel = computed(() => `已选择 ${selectedRepositoryNames.value.length} 个`)
/**
 * Story 服务生命周期与运行期监督。
 * 服务的启动、停止、删除映射与监督事件都由它统一管理，页面只负责渲染。
 */
/* ------------------------- 实例页：服务生命周期与运行期监督 ------------------------- */

const lifecycle = useServiceLifecycle({ onChange: async () => { await store.refresh() } })
/** Story ID → 服务状态（模板沿用既有命名） */
const storyServices = lifecycle.services
/** 正在操作的 Story ID */
const startingStoryService = lifecycle.loadingStoryId
/** 服务操作错误 */
const storyServiceError = lifecycle.error
/** 未关闭的运行期监督事件（模板需要顶层绑定才能自动解包） */
const activeServiceEvents = lifecycle.activeEvents
/** 是否存在 error 级监督事件 */
const hasServiceFailure = lifecycle.hasServiceFailure
/** 关闭一条监督事件 */
const dismissServiceEvent = lifecycle.dismissEvent
/** 读取某个 Story 最近的服务操作失败原因 */
const serviceErrorOf = lifecycle.errorOf
/** 实例写操作的结果提示（成功/失败） */
const actionToasts = useActionToasts()
/** 提示列表（模板顶层绑定） */
const actionToastItems = actionToasts.toasts
/** 关闭一条操作提示 */
const dismissActionToast = actionToasts.dismiss
/** 收件箱答案草稿：仅本地存储，用于汇总复制，不回写上游 */
const inboxAnswers = useInboxAnswers()
/** 答案映射（模板顶层绑定） */
const inboxAnswerMap = inboxAnswers.answers
/** 当前展开答案面板的事项 ID */
const inboxExpandedId = inboxAnswers.expandedId
/** 实例详情与列表偏好（置顶/分组） */
const jobExtras = useJobExtras()
/** 当前实例详情 */
const jobDetail = jobExtras.detail
/** 详情加载中 */
const jobDetailLoading = jobExtras.detailLoading
/** 详情读取失败原因 */
const jobDetailError = jobExtras.detailError
/** 置顶写操作进行中 */
const jobPinSaving = jobExtras.pinSaving
/** 偏好读取失败原因 */
const jobPrefsError = jobExtras.prefsError
/** 实例状态筛选 */
const jobStateFilter = ref<'all' | 'active' | 'done' | 'failed'>('all')
const storyJobs = ref<Job[]>([])
const selectedJob = ref<Job | null>(null)
const selectedStoryId = ref('')
const resumableSessions = ref<Array<{ sessionId: string; name?: string }>>([])
const selectedResumableSession = ref('')
const resumableLoading = ref(false)
const jobName = ref('')
const renameDraft = ref('')
const jobPrompt = ref('')
const jobReply = ref('')
/** 文件上传：供新建轮次与回复实例两个输入框共用 */
const { uploading: imageUploading, error: uploadError, uploadImage } = useStoryUpload()
const jobTranscript = ref('')
const jobOutput = ref('')
const jobError = ref('')
const jobActionLoading = ref(false)
/** 定时任务写操作错误 */
/* ------------------------- 定时任务：状态、子 composable 与编辑弹层 ------------------------- */

const cronError = ref('')
/** 定时任务搜索关键词 */
const cronQuery = ref('')
/** 定时任务状态筛选 */
const cronStatusFilter = ref<'all' | 'enabled' | 'paused' | 'attention'>('all')
/** 派发轮次：用于展示未归档轮次并提供归档入口 */
// cron 写操作会改变本地任务/轮次，发 force 让服务端重建 local 段；runtime 本就实时
const cronDispatches = useCronDispatches(async () => { await store.refresh(true) })
/** 定时任务写操作：乐观更新、失败回滚与撤销提示 */
const cronActions = useCronActions({
  // 写操作会改变任务与轮次状态，两者都要刷新
  onRefresh: async () => {
    await store.refresh(true)
    await cronDispatches.refresh()
  },
  onError: (message: string) => { cronError.value = message },
})
/** 行内执行记录 */
const cronExecutions = useCronExecutions()
/** 当前展开执行记录的任务 ID */
const expandedCronId = ref('')
/** cron 编辑弹层开关 */
const cronEditorOpen = ref(false)
/** 正在编辑的任务；为空表示新建 */
const editingCron = ref<Cron | null>(null)
/** 新建任务的目标 Story */
const editorStoryId = ref('')
/** 编辑保存中 */
const cronSaving = ref(false)
/** 编辑保存错误 */
const cronEditorError = ref('')
/** 审计抽屉开关 */
const auditOpen = ref(false)
/** 审计流水与撤销 */
const auditTrail = useAuditTrail(async () => { await store.refresh(true) })
/* 组合式函数返回的 ref 需要顶层绑定，模板才会自动解包 */
/** 执行记录列表 */
const cronExecutionRows = cronExecutions.executions
/** 执行记录加载中 */
const cronExecutionsLoading = cronExecutions.loading
/** 执行记录错误 */
const cronExecutionsError = cronExecutions.error
/** 执行记录来源 */
const cronExecutionsSource = cronExecutions.source
/** 执行记录兜底告警 */
const cronExecutionsWarning = cronExecutions.warning
/** 执行记录是否还有下一页 */
const cronExecutionsHasMore = cronExecutions.hasMore
/** 撤销提示条 */
const cronNotices = cronActions.notices
/** 正在处理的任务 ID */
const cronBusyTaskId = cronActions.busyTaskId
/** 审计条目 */
const auditEntries = auditTrail.entries
/** 审计加载中 */
const auditLoading = auditTrail.loading
/** 审计错误 */
const auditError = auditTrail.error
/** 正在撤销的审计条目 */
const auditUndoingId = auditTrail.undoingId

/**
 * 按任务与过滤条件加载执行记录（模板调用的薄封装）。
 * @param taskId 任务 ID
 * @param filters 过滤条件
 * @returns Promise<void>
 */
async function loadCronExecutions(
  taskId: string,
  filters: { status?: 'queued' | 'running' | 'succeeded' | 'failed'; query?: string },
): Promise<void> {
  await cronExecutions.load(taskId, filters)
}

/**
 * 加载更多执行记录（模板调用的薄封装）。
 * @returns Promise<void>
 */
async function loadMoreCronExecutions(): Promise<void> {
  await cronExecutions.loadMore()
}

/**
 * 刷新审计流水（模板调用的薄封装）。
 * @returns Promise<void>
 */
async function refreshAuditTrail(): Promise<void> {
  await auditTrail.refresh()
}

/**
 * 撤销一条审计动作（模板调用的薄封装）。
 * @param id 审计条目 ID
 * @returns Promise<void>
 */
async function undoAuditEntry(id: string): Promise<void> {
  await auditTrail.undo(id)
}

/**
 * 撤销定时任务动作（撤销提示条调用）。
 * @param auditId 审计条目 ID
 * @returns Promise<void>
 */
async function undoCronAction(auditId: string): Promise<void> {
  await cronActions.undo(auditId)
}

/**
 * 关闭一条撤销提示。
 * @param id 提示 ID
 */
function dismissCronNotice(id: string): void {
  cronActions.dismiss(id)
}
/** MR diff 摘要，按 `projectId:iid` 缓存 */
let jobStreamController: AbortController | undefined
/** 实例页列表轮询定时器 */
let jobsPollTimer: ReturnType<typeof setInterval> | undefined
let workspacePollTimer: ReturnType<typeof setTimeout> | undefined
/** 工作区初始化轮询代际令牌：每次开启新一轮或取消时自增，用于作废旧 job 的在途回调 */
let workspacePollGeneration = 0

/**
 * 取消当前工作区初始化轮询，并作废其所有在途回调。
 * 通过递增代际令牌实现：即便旧 setTimeout 已排队执行，也会因令牌不匹配被丢弃。
 */
function cancelWorkspacePolling(): void {
  workspacePollGeneration += 1
  if (workspacePollTimer) {
    clearTimeout(workspacePollTimer)
    workspacePollTimer = undefined
  }
}

const page = computed(() => String(route.meta.page ?? 'inbox'))
const requirements = computed(() => {
  const rows = store.snapshot?.requirements ?? []
  const query = search.value.trim().toLocaleLowerCase()
  return query ? rows.filter((row) => row.title.toLocaleLowerCase().includes(query) || row.storyId.toLocaleLowerCase().includes(query)) : rows
})
const inbox = computed(() => store.snapshot?.inbox ?? [])

/** 收件箱中同一 Story 的待决策事项 */
interface InboxStoryGroup {
  key: string
  /** Story 标识；无法归属到 Story 时显示占位文案 */
  storyId: string
  /** Story 标题，取自需求快照 */
  title: string
  items: InboxItem[]
  highCount: number
}

/** 收件箱中同一工作区的待决策事项：工作区 → Story → 事项 */
interface InboxWorkspaceGroup {
  key: string
  /** 工作区名（`*.code-workspace` 文件名），与看板/流水线同一口径 */
  name: string
  /** Story 所在项目目录，仅当比工作区名更具体时展示 */
  pathHint: string
  /** 该组是否被工作区流水线认领；false 表示 Story 没进任何工作区，属于未同步数据 */
  synced: boolean
  itemCount: number
  highCount: number
  stories: InboxStoryGroup[]
}

/** 未被工作区流水线认领的事项统一落到这个兜底分组 */
const unsyncedWorkspaceName = '未同步到工作区'

/**
 * 收件箱分组：工作区 → Story → 待决策事项。
 *
 * 骨架是**工作区列表**（`workspacePipelines`），顺序沿用工作区扫描结果：
 * 一个工作区最多一个 Story（`*.code-workspace` 的 `folders[0]` + 该项目的 `.codebuddy/plans`），
 * Story 下面才是它的 open question / blocked 事项。没有事项的工作区不出现。
 * 快照来自旧后端或出现未认领事项时，尾部追加「未同步到工作区」兜底分组，避免数据凭空消失。
 *
 * @returns 分组后的收件箱数据，直接供模板渲染
 */
/* ------------------------- 收件箱：分组、建议稿与答复汇总 ------------------------- */

const inboxGroups = computed<InboxWorkspaceGroup[]>(() => {
  const titles = new Map((store.snapshot?.requirements ?? []).map((requirement) => [requirement.storyId, requirement.title]))
  const itemsByStory = new Map<string, InboxItem[]>()
  const unattachedItems: InboxItem[] = []

  for (const item of inbox.value) {
    const storyId = item.requirementId
    if (!storyId) {
      unattachedItems.push(item)
      continue
    }
    const bucket = itemsByStory.get(storyId)
    if (bucket) bucket.push(item)
    else itemsByStory.set(storyId, [item])
  }

  /**
   * 把一批事项打包成一个 Story 分组。
   * @param key 分组键
   * @param storyId Story 标识
   * @param items 该 Story 的事项
   * @returns Story 分组
   */
  const toStoryGroup = (key: string, storyId: string, items: InboxItem[]): InboxStoryGroup => ({
    key,
    storyId: storyId || '未归属 Story',
    title: titles.get(storyId) ?? (storyId || '未归属 Story'),
    items,
    highCount: items.filter((item) => item.priority === 'high').length,
  })

  const groups: InboxWorkspaceGroup[] = []
  for (const pipeline of workspacePipelines.value) {
    const requirement = pipeline.story?.requirement
    if (!requirement) continue
    const items = itemsByStory.get(requirement.storyId)
    if (!items?.length) continue
    itemsByStory.delete(requirement.storyId)
    const story = toStoryGroup(`inbox:${pipeline.path}:${requirement.storyId}`, requirement.storyId, items)
    groups.push({
      key: `inbox:${pipeline.path}`,
      name: pipeline.name,
      pathHint: requirement.workspacePath && requirement.workspacePath !== pipeline.name ? requirement.workspacePath : '',
      synced: true,
      itemCount: items.length,
      highCount: story.highCount,
      stories: [story],
    })
  }

  // 兜底：工作区列表里找不到归属的事项（旧快照 / Story 未被认领）单独成组，不静默丢弃
  const leftovers = [...itemsByStory.values()].flat()
  if (leftovers.length || unattachedItems.length) {
    const stories = [...itemsByStory.entries()].map(([storyId, items]) =>
      toStoryGroup(`unsynced:${storyId}`, storyId, items))
    if (unattachedItems.length) {
      stories.push(toStoryGroup('unsynced:no-story', '', unattachedItems))
    }
    const allItems = [...leftovers, ...unattachedItems]
    groups.push({
      key: 'inbox:unsynced',
      name: unsyncedWorkspaceName,
      pathHint: '',
      synced: false,
      itemCount: allItems.length,
      highCount: allItems.filter((item) => item.priority === 'high').length,
      stories,
    })
  }
  return groups
})

/**
 * 建议稿索引：以 `storyId:questionId` 为键，值为建议稿文本。
 * 来源与看板「需求待确认项」一致（store.snapshot.openQuestions），只取有 resolution 的条目。
 * 收件箱 open_question 事项的 id 形如 `question:<storyId>:<questionId>`，据此关联。
 */
const questionSuggestions = computed<Map<string, string>>(() => {
  const map = new Map<string, string>()
  for (const question of store.snapshot?.openQuestions ?? []) {
    if (question.resolution?.trim()) {
      map.set(`${question.storyId}:${question.id}`, question.resolution)
    }
  }
  return map
})

/**
 * 读取某条收件箱事项对应的建议稿。
 * @param item 收件箱事项
 * @returns 建议稿文本；无对应建议稿时返回空字符串
 */
function suggestionOf(item: InboxItem): string {
  const storyId = item.requirementId ?? ''
  const separator = item.id.lastIndexOf(':')
  const questionId = separator >= 0 ? item.id.slice(separator + 1) : ''
  return questionSuggestions.value.get(`${storyId}:${questionId}`) ?? ''
}

/** 把建议稿按圈号切成分段，供面板分行展示（纯函数，模板不重复解析） */
const suggestionSegmentsOf = (item: InboxItem) => splitSuggestion(suggestionOf(item))

/**
 * 统计一组事项中已填写答案的数量，用于单个 Story 的汇总按钮计数胶囊。
 * @param items 该 Story 下的收件箱事项
 * @returns 已填写答案的条数
 */
function storyAnswerCount(items: InboxItem[]): number {
  return items.filter((item) => inboxAnswerMap.value[item.id]?.text.trim()).length
}

/** 与 kind 标签语义重复的通用原因文案：open question 的「待用户确认」已由 kind 标签表达，不再重复展示 */
const redundantInboxReason = '待用户确认。'

/**
 * 读取事项原因；若只是重复 kind 标签的通用文案则返回空串，避免同一行出现两层同义信息。
 * @param item 收件箱事项
 * @returns 需要展示的原因文本；无有效原因时返回空字符串
 */
function inboxReasonOf(item: InboxItem): string {
  return item.reason === redundantInboxReason ? '' : item.reason
}

/**
 * 设置某条事项的答案，交给 composable 防抖落盘。
 * @param id 收件箱事项 ID
 * @param text 输入的答案文本
 */
function setInboxAnswer(id: string, text: string): void {
  inboxAnswers.setAnswer(id, text)
}

/**
 * 切换某条事项的答案面板展开/收起。
 * @param id 收件箱事项 ID
 */
function toggleInboxAnswer(id: string): void {
  inboxAnswers.toggleExpanded(id)
}

/**
 * 读取某条事项的当前答案文本，供 textarea 双向绑定。
 * @param id 收件箱事项 ID
 * @returns 答案文本；无答案时返回空字符串
 */
function inboxAnswerText(id: string): string {
  return inboxAnswerMap.value[id]?.text ?? ''
}

/**
 * 把某个 Story 下已填答案按 Qn:答案 格式汇总并复制到剪贴板。
 * 每个 Story 独立编号（Q1 起），复制不改变收件箱状态。
 * 剪贴板 API 不可用时回退到 execCommand。
 * @param items 该 Story 下的收件箱事项
 */
async function copyStoryAnswers(items: InboxItem[]): Promise<void> {
  const count = storyAnswerCount(items)
  if (!count) {
    actionToasts.notify('这个 Story 还没有填写答案。', 'error')
    return
  }
  const text = buildInboxAnswerText(items, inboxAnswerMap.value)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const helper = document.createElement('textarea')
      helper.value = text
      helper.setAttribute('readonly', '')
      helper.style.position = 'fixed'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(helper)
      if (!ok) throw new Error('execCommand 返回 false')
    }
    actionToasts.notify(`已复制「${items[0]?.requirementId ?? 'Story'}」的 ${count} 条答案。`, 'success')
  } catch {
    actionToasts.notify('复制失败，请手动选择文本。', 'error')
  }
}

/** 定时任务列表：快照事实 + 本地乐观覆盖（覆盖仅用于写操作期间的即时反馈） */
const crons = computed<Cron[]>(() => (store.snapshot?.crons ?? []).map((cron) => {
  const override = cronActions.overrides.value[cron.id]
  return override ? { ...cron, ...override } : cron
}))
const jobs = computed(() => [...(store.snapshot?.jobs ?? []), ...storyJobs.value])
const storyServiceRequirements = computed(() => requirements.value.filter((requirement) => requirement.workspacePath))
/** 工作区流水线视图：一个工作区一条流水线，最多一个 Story */
const workspacePipelines = computed<WorkspacePipeline[]>(() => store.snapshot?.workspacePipelines ?? [])
/** 流水线页计数：已经识别到 Story 的工作区数量 */
const pipelineStoryCount = computed(() => workspacePipelines.value.filter((pipeline) => pipeline.story).length)
/** 已被工作区流水线认领的定时任务 ID，用于兜底展示未归属任务 */
const assignedCronIds = computed(() => new Set(workspacePipelines.value.flatMap((pipeline) => [
  ...pipeline.crons.map((cron) => cron.id),
  ...(pipeline.story?.crons ?? []).map((cron) => cron.id),
])))
/** 未能归属到工作区项目的定时任务（例如工作区扫描失败时的兜底数据） */
const unassignedCrons = computed<Cron[]>(() => crons.value.filter((cron) => !assignedCronIds.value.has(cron.id)))
const activeWorkflows = computed(() => store.snapshot?.harnessActive ?? [])
/**
 * 已知数据通道的展示顺序与中文名。
 * 快照里完全没有该 key 时仍然要列出来并标注「未检测」，
 * 否则用户看到的是一句兜底话，而不是「哪条通道没接」。
 */
/* ------------------------- 通道状态展示（看板 / 连接与配置共用） ------------------------- */

const channelCatalog = [
  { key: 'tapd', label: 'TAPD', purpose: '需求与缺陷' },
  { key: 'gitlab', label: 'GitLab', purpose: '合并请求' },
  { key: 'devops', label: 'DevOps', purpose: '构建与部署' },
  { key: 'codebuddy', label: 'CodeBuddy', purpose: '实例与轮次' },
  { key: 'crons', label: '定时任务', purpose: 'scheduled_tasks.json' },
  { key: 'localHarness', label: '本地 Harness', purpose: 'e2e-state 与工作区' },
] as const

/**
 * 把上游原始报错翻译成「谁出的问题 + 可能原因 + 该做什么」。
 * 上游返回的英文原文不直接展示给用户，但会保留在 tooltip 中便于排查。
 * @param raw 原始错误文本
 * @returns 中文说明与恢复动作
 */
function describeChannelError(raw: string): { reason: string; action: string } {
  const text = raw.toLowerCase()
  // 本项目 MCP 客户端 / TAPD 适配器自身生成的错误文案不来自上游 HTTP，
  // 不匹配 4xx/5xx，过去会落到「未识别的错误」兜底。需与后端实际抛出的文案保持一致。
  if (/missing required read-only tools|required read-only tools/.test(text)) {
    return { reason: 'MCP 服务缺少本控制台要求的只读工具', action: '确认 mcp-server-tapd 版本与 requiredReadTools 清单一致后重新检测' }
  }
  if (/mcp connection failed|mcp 启动失败|mcp.*is not configured|mcp.*connect|handshake|spawn.*failed/.test(text)) {
    return { reason: 'MCP 服务连接或握手失败（可能是限流、进程启动失败或配置错误）', action: '确认本机 MCP 服务可用后重新检测' }
  }
  if (/tapd is not configured|not configured|no config|未配置/.test(text)) {
    return { reason: '尚未配置该通道', action: '在「连接与配置」补齐后再检测' }
  }
  if (/429|rate limit|quota|too many/.test(text)) {
    return { reason: '上游限流或配额用尽', action: '等待几分钟后到「连接与配置」重新检测' }
  }
  if (/401|403|unauthori[sz]ed|expired|session/.test(text)) {
    return { reason: '令牌或登录会话失效', action: '在「连接与配置」更新凭证后重新检测' }
  }
  if (/timeout|etimedout|\btimed out\b|econnrefused/.test(text)) {
    return { reason: '网络超时或服务未启动', action: '确认本机网络与该服务可用后重试' }
  }
  if (/request failed|failed to fetch|network error|\b5\d\d\b|internal server/.test(text)) {
    return { reason: '上游服务返回了失败响应，可能是令牌过期、配额用尽或该服务暂时不可用', action: '先到「连接与配置」重新检测，确认是哪一条通道失败' }
  }
  return { reason: '上游返回了未识别的错误', action: '请查看下方原始错误信息并据此排查' }
}

/**
 * 工具页通道列表：快照里没有的已知通道补一条「未检测」，未知通道追加在末尾。
 * @returns 按展示顺序排好的行数据
 */
/**
 * 看板页的 TAPD 错误说明。
 * 模板里需要同时在标题、说明与原文三处使用，提取为计算属性避免重复解析。
 */
const boardErrorHint = computed(() => describeChannelError(board.error ?? ''))

/**
 * 看板右上角的 TAPD 通道标签。
 * 查询失败、已连接、不可用三种情况各自对应一个语气，模板里不再嵌套三元。
 */
const boardStatusTag = computed<{ tone: string; label: string }>(() => {
  if (board.error) return { tone: 'tag-danger', label: 'TAPD 查询失败' }
  return board.channelOk
    ? { tone: 'tag-success', label: 'TAPD 已连接' }
    : { tone: 'tag-warning', label: 'TAPD 不可用' }
})

const channelRows = computed(() => {
  const present = store.snapshot?.channels ?? {}
  const known = channelCatalog.map((entry) => ({
    key: entry.key,
    label: entry.label,
    purpose: entry.purpose,
    channel: (present as Record<string, { ok: boolean; error?: string; fetchedAt?: string; stale?: boolean } | undefined>)[entry.key],
  }))
  const extra = Object.entries(present)
    .filter(([key]) => !channelCatalog.some((entry) => entry.key === key))
    .map(([key, channel]) => ({ key, label: key, purpose: '', channel }))
  return [...known, ...extra]
})

/**
 * 解析 CodeBuddy 通道的展示信息。
 * 后端把 CLI 版本或安装提示统一放在 channel.error 字段中承载：
 * - 已安装：形如 `codebuddy 2.185.0`，直接作为版本文案展示；
 * - 未安装：含安装链接，提取为可点击链接。
 * @param raw 通道 error 字段原文
 * @returns 展示文本与安装链接（无链接时为空串）
 */
function codebuddyChannelView(raw: string): { text: string; installUrl: string } {
  const urlMatch = raw.match(/https?:\/\/\S+/)
  const installUrl = urlMatch ? urlMatch[0] : ''
  const text = installUrl ? raw.replace(installUrl, '').trim() : raw
  return { text, installUrl }
}

/** 任一已知通道不可用或尚未检测 */
const channelUnavailable = computed(() =>
  channelRows.value.some((row) => !row.channel || !row.channel.ok),
)

/**
 * 取某个 Story 关联的实例列表：快照聚合的实例与本地新拉的实例合并后按 storyId 过滤。
 * @param storyId Harness Story ID
 * @returns 该 Story 下的实例数组
 */
/* ------------------------- 实例页：辅助判断与写操作 ------------------------- */

function jobsByStory(storyId: string): Job[] {
  const pinned = new Set(jobExtras.prefs.value.pinned)
  return jobs.value
    .filter((job) => job.storyId === storyId)
    .filter((job) => jobMatchesFilter(job))
    // 置顶的实例排在前面，多个实例时不用翻找正在关注的那个
    .sort((left, right) => Number(pinned.has(right.id)) - Number(pinned.has(left.id)))
}

/**
 * 判断主会话是否被直接选中；查看子任务时父级只保留弱归属高亮。
 * @param storyId Story 标识
 * @returns 正在查看该主会话时返回 true
 */
function isMainSessionSelected(storyId: string): boolean {
  return selectedStoryId.value === storyId && !selectedJob.value
}

/**
 * 判断 Story 是否包含当前查看的 Job 子任务。
 * @param storyId Story 标识
 * @returns 子任务属于该 Story 时返回 true
 */
function hasSelectedJob(storyId: string): boolean {
  return selectedJob.value?.storyId === storyId
}

/**
 * 判断 Job 子任务是否为当前查看对象，同时校验 Story 避免跨服务 ID 冲突。
 * @param job 待判断的 Job 子任务
 * @returns 当前选中时返回 true
 */
function isJobSelected(job: Job): boolean {
  const current = selectedJob.value
  return current?.id === job.id && current.storyId === job.storyId
}

/**
 * 获取 Job 子任务的状态点样式。
 * @param job Job 子任务
 * @returns 对应状态点 CSS 类名
 */
function jobDotClass(job: Job): string {
  if (job.state === 'failed') return 'is-error'
  if (job.status === 'busy' || job.state === 'working') return 'is-active'
  return ''
}

/**
 * 获取 Job 子任务的中文状态文案，未知状态保留上游原值。
 * @param job Job 子任务
 * @returns 用于列表展示的状态文案
 */
function jobStateLabel(job: Job): string {
  if (job.state === 'working') return '执行中'
  if (job.state === 'done') return '已完成'
  if (job.state === 'stopped') return '已停止'
  if (job.state === 'failed') return '异常'
  if (job.state === 'queued') return '等待中'
  return job.state
}

/**
 * 实例是否命中当前状态筛选。
 * @param job 实例
 * @returns 命中返回 true
 */
function jobMatchesFilter(job: Job): boolean {
  const filter = jobStateFilter.value
  if (filter === 'all') return true
  if (filter === 'active') return job.status === 'busy' || job.state === 'working'
  if (filter === 'done') return job.state === 'done' || job.state === 'stopped'
  return job.state === 'failed'
}

/** 当前选中实例是否已置顶 */
const selectedJobPinned = computed(() => (
  selectedJob.value ? jobExtras.prefs.value.pinned.includes(selectedJob.value.id) : false
))

/**
 * 切换当前实例的置顶状态。
 * @returns Promise<void>
 */
async function toggleSelectedJobPin(): Promise<void> {
  const job = selectedJob.value
  if (!job?.storyId) return
  await jobExtras.togglePin(job.storyId, job.id, !selectedJobPinned.value)
}

/**
 * 把上游给出的建议回复填入回复框。
 * @param text 建议回复文案
 */
function useSuggestedReply(text: string): void {
  if (text) jobReply.value = text
}

/**
 * 处理输入框旁的上传事件：上传文件并把引用追加到目标输入框。
 * 图片用 Markdown 图片语法 `![名](路径)`，其它类型用普通链接 `[名](路径)`，
 * 便于 CodeBuddy agent 依据路径读取刚上传的文件。
 * @param file 用户选择的文件（el-upload 的 UploadRawFile，兼容 File）
 * @param target 目标输入框：'prompt' 新建轮次，'reply' 回复实例
 */
async function handleStoryFileUpload(file: File, target: 'prompt' | 'reply'): Promise<void> {
  const storyId = target === 'reply' ? selectedJob.value?.storyId : selectedStoryId.value
  if (!storyId) {
    actionToasts.notify('请先选中一个 Story 再上传文件。', 'error')
    return
  }
  let asset: UploadedAsset
  try {
    asset = await uploadImage(storyId, file)
  } catch {
    actionToasts.notify(uploadError.value || '文件上传失败。', 'error')
    return
  }
  // CodeBuddy 服务以项目根为 cwd，agent 可据此读取 .docs/<storyId>/ 下刚上传的文件。
  const label = asset.originalName || asset.name
  const isImage = asset.mimeType.startsWith('image/')
  const reference = isImage
    ? `![${label}](${asset.relativePath})`
    : `[${label}](${asset.relativePath})`
  const current = target === 'prompt' ? jobPrompt.value : jobReply.value
  const next = current ? `${current.replace(/\s*$/, '')}\n${reference}` : reference
  if (target === 'prompt') jobPrompt.value = next
  else jobReply.value = next
  actionToasts.notify('文件已上传并插入提示词。', 'success')
}

/** el-upload 的 prompt 输入框上传回调 */
function onPromptFileChange(uploadFile: UploadFile): void {
  if (uploadFile.raw) void handleStoryFileUpload(uploadFile.raw, 'prompt')
}

/** el-upload 的 reply 输入框上传回调 */
function onReplyFileChange(uploadFile: UploadFile): void {
  if (uploadFile.raw) void handleStoryFileUpload(uploadFile.raw, 'reply')
}

/** 实例页的「工作区 → 第一个项目 → Story」分组 */
interface InstanceGroup {
  key: string
  name: string
  path: string
  /** 第一个项目；`.code-workspace` 没声明项目时缺省 */
  project?: { name: string; branch?: string }
  /** 该工作区的唯一 Story */
  stories: Requirement[]
}

/** 定时页的「工作区 → 第一个项目 → Story → 定时任务」分组 */
interface CronStoryGroup {
  requirement: Requirement
  crons: Cron[]
}
interface CronGroup {
  key: string
  name: string
  path: string
  /** 第一个项目；`.code-workspace` 没声明项目时缺省 */
  project?: { name: string; branch?: string }
  /** 该工作区唯一 Story 的定时任务 */
  stories: CronStoryGroup[]
  /** 第一个项目下未关联 Story 的任务 */
  looseCrons: Cron[]
  /** 兜底分组：完全无法定位到工作区的任务 */
  unassignedCrons: Cron[]
}

/**
 * 实例页分组：以工作区为根，只展示第一个项目下识别到的 Story。
 * @returns 实例页分组数组
 */
const instanceGroups = computed<InstanceGroup[]>(() => workspacePipelines.value.map((pipeline) => ({
  key: `instance:${pipeline.path}`,
  name: pipeline.name,
  path: pipeline.path,
  ...(pipeline.primaryProject
    ? {
        project: {
          name: pipeline.primaryProject.name,
          ...(pipeline.primaryProject.branch ? { branch: pipeline.primaryProject.branch } : {}),
        },
      }
    : {}),
  stories: pipeline.story ? [pipeline.story.requirement] : [],
})))

/**
 * 各实例分组的空态引导文案（纯静态文字，无跳转交互）。
 * Story 本体由 Harness 在项目中执行 /start 生成 .codebuddy/plans/story-info.json，
 * 新建工作区默认为空，因此这里给出可操作的静态指引，告知用户如何生成 Story 后回来刷新。
 * 以 group.key 为键供模板在 stories 为空时直接取用，避免在 template 中拼接多条件判断。
 */
const emptyWorkspaceGuides = computed<Record<string, string>>(() => {
  const guides: Record<string, string> = {}
  for (const group of instanceGroups.value) {
    const subject = group.project?.name ? `项目 ${group.project.name} ` : '当前工作区'
    guides[group.key] = `${subject}下还没有 Story。点「新建 Story」在右侧填写信息创建骨架，即可启动实例并在对话中执行 /start 补全需求。`
  }
  return guides
})

/* ------------------------- 空工作区：新建最小 Story 骨架 ------------------------- */

/** 新建 Story 表单草稿：业务标识 + 标题 */
const storyDraft = ref<{ storyId: string; title: string }>({ storyId: '', title: '' })
/** 新建 Story 的表单校验 / 接口错误 */
const storyCreateError = ref('')
/** 新建 Story 提交中标记 */
const storyCreating = ref(false)
/** 当前在右侧创建区锁定的空工作区 key；非空时右侧展示新建 Story 表单 */
const selectedEmptyGroupKey = ref('')
/** 当前创建表单锁定的工作区 key 与 name */
const storyTargetWorkspace = ref<{ key: string; name: string }>({ key: '', name: '' })
/**
 * 工作区关联的 TAPD 需求推导状态：
 * pending 查询中 / bound 已关联（带 TAPD 来源）/ unbound 未关联。
 * 由看板「工作区 ↔ TAPD 需求」绑定自动推导，无需用户输入。
 */
const storyTapdBinding = ref<
  | { state: 'pending' }
  | { state: 'bound'; storyIdInTapd: string; tapdUrl?: string; owner?: string; title: string }
  | { state: 'unbound' }
>({ state: 'pending' })
/** TAPD 推导代际令牌：快速切换工作区时作废旧推导，避免把 A 的绑定写到 B 的 Story */
let storyBindingGeneration = 0

/**
 * 选中一个空工作区并在右侧打开「新建 Story」表单。
 * 清空当前 Story / Job 选中态，避免右侧同时渲染实例内容与创建表单；
 * 然后从看板绑定自动推导该工作区关联的 TAPD 需求（board 未加载时主动补拉）。
 * 使用代际令牌保证：快速切换工作区时，只有最后一次推导能写入结果。
 * @param group 被点击的空工作区实例分组
 * @returns Promise<void>
 */
async function selectEmptyWorkspace(group: InstanceGroup): Promise<void> {
  const generation = ++storyBindingGeneration
  selectedEmptyGroupKey.value = group.key
  storyTargetWorkspace.value = { key: group.key, name: group.name }
  storyDraft.value = { storyId: '', title: '' }
  storyCreateError.value = ''
  selectedStoryId.value = ''
  if (selectedJob.value) {
    jobStreamController?.abort()
    selectedJob.value = null
    jobExtras.clearDetail()
    jobTranscript.value = ''
    jobOutput.value = ''
  }

  // 自动带出 TAPD 关联：board 仅在看板页加载，实例页可能未加载，这里按需补拉
  storyTapdBinding.value = { state: 'pending' }
  try {
    if (!board.fetchedAt || board.error) await board.load()
    // 请求飞行期间可能已切到别的工作区，令牌不符则丢弃，避免串数据
    if (generation !== storyBindingGeneration) return
    const stories: BoardStory[] = board.stories
    const binding = stories.find((story) => story.workspaceName === group.name)
    // 写入前二次校验：目标工作区必须与当前锁定一致，否则丢弃旧推导
    if (generation !== storyBindingGeneration || storyTargetWorkspace.value.name !== group.name) return
    if (binding?.storyId) {
      storyTapdBinding.value = {
        state: 'bound',
        storyIdInTapd: binding.storyId,
        ...(binding.tapdUrl ? { tapdUrl: binding.tapdUrl } : {}),
        ...(binding.owner ? { owner: binding.owner } : {}),
        title: binding.title,
      }
    } else {
      storyTapdBinding.value = { state: 'unbound' }
    }
  } catch {
    // board.load() 内部已吞异常并写 board.error，这里仅兜底为未关联
    if (generation !== storyBindingGeneration) return
    storyTapdBinding.value = { state: 'unbound' }
  }
}

/** 取消在右侧的新建 Story 表单，回到默认占位态。 */
function cancelStoryCreate(): void {
  if (storyCreating.value) return
  selectedEmptyGroupKey.value = ''
  storyTargetWorkspace.value = { key: '', name: '' }
  storyDraft.value = { storyId: '', title: '' }
  storyCreateError.value = ''
  storyTapdBinding.value = { state: 'pending' }
}

/**
 * 提交新建最小 Story 骨架。
 * 成功后强制刷新快照重建 local 扫描段，instanceGroups 为 computed 会自动重算，
 * 新 Story 卡片随即出现，用户即可启动实例并在对话中执行 /start 补全。
 * @returns Promise<void>，失败信息写入 storyCreateError
 */
async function submitStoryCreate(): Promise<void> {
  const draft = storyDraft.value
  const storyId = draft.storyId.trim()
  const title = draft.title.trim()
  // 前端校验：与后端 storyCreateRequestSchema 同口径，提前给出友好提示
  if (!/^[A-Za-z0-9._-]+$/.test(storyId) || storyId === '.' || storyId === '..') {
    storyCreateError.value = 'Story ID 仅允许字母、数字、点、下划线、连字符，且不能是 . 或 ..'
    return
  }
  if (!title) {
    storyCreateError.value = '请填写 Story 标题。'
    return
  }
  storyCreating.value = true
  storyCreateError.value = ''
  try {
    // 组装 TAPD 来源：仅在推导出绑定时携带，后端据此写 sources.storyIdInTapd
    const binding = storyTapdBinding.value
    const sources = binding.state === 'bound'
      ? {
          storyIdInTapd: binding.storyIdInTapd,
          ...(binding.tapdUrl ? { tapdUrl: binding.tapdUrl } : {}),
          ...(binding.owner ? { owner: binding.owner } : {}),
        }
      : undefined
    await apiRequest('/api/v1/stories', {
      method: 'POST',
      body: JSON.stringify({
        storyId,
        title,
        workspaceName: storyTargetWorkspace.value.name,
        ...(sources ? { sources } : {}),
      }),
    })
    // 重建 local 段：readPlans 扫描到新目录，实例卡片自动出现
    await store.refresh(true)
    // 创建完成后退出创建态并自动聚焦新 Story，右侧切换为实例操作面板
    selectedEmptyGroupKey.value = ''
    selectedStoryId.value = storyId
    actionToasts.notify(`Story「${title}」已创建，现在可以启动实例并在对话中执行 /start ${storyId}`, 'success')
  } catch (cause) {
    storyCreateError.value = cause instanceof Error ? cause.message : '创建 Story 失败。'
  } finally {
    storyCreating.value = false
  }
}

/**
 * 定时页分组：同样以工作区为根，一个工作区只展示第一个项目的 Story 任务。
 * 未归属到任何工作区的任务进入兜底分组。
 */
const cronGroups = computed<CronGroup[]>(() => {
  const groups: CronGroup[] = workspacePipelines.value.map((pipeline) => ({
    key: `cron:${pipeline.path}`,
    name: pipeline.name,
    path: pipeline.path,
    ...(pipeline.primaryProject
      ? {
          project: {
            name: pipeline.primaryProject.name,
            ...(pipeline.primaryProject.branch ? { branch: pipeline.primaryProject.branch } : {}),
          },
        }
      : {}),
    // 没有任务的 Story 也保留，确保「新建任务」入口不会随空列表一起消失
    stories: pipeline.story
      ? [{ requirement: pipeline.story.requirement, crons: pipeline.story.crons }]
      : [],
    // pipeline.crons 已含该 Story 的任务，这里只留下未关联 Story 的部分
    looseCrons: pipeline.crons.filter((cron) => !cron.storyId),
    unassignedCrons: [],
  }))

  const unassigned = unassignedCrons.value
  if (unassigned.length) {
    groups.push({
      key: 'cron:unassigned',
      name: '未归属定时任务',
      path: '任务无法定位到工作区项目',
      stories: [],
      looseCrons: [],
      unassignedCrons: unassigned,
    })
  }
  return groups
})

/**
 * 右侧工作区当前上下文对应的 Story。
 * 优先从实例分组取（带工作区信息），分组缺失时回退到快照需求，保证深链或数据刷新后不丢上下文。
 * @returns 当前 Story；未选择时返回 undefined
 */
const currentStory = computed<Requirement | undefined>(() => {
  if (!selectedStoryId.value) return undefined
  const grouped = instanceGroups.value
    .flatMap((group) => group.stories)
    .find((requirement) => requirement.storyId === selectedStoryId.value)
  if (grouped) return grouped
  return store.snapshot?.requirements.find((row) => row.storyId === selectedStoryId.value)
})

/** 当前 Story 的服务登记（未启动时缺省） */
const currentService = computed<StoryServiceInfo | undefined>(() => (
  selectedStoryId.value ? storyServices.value[selectedStoryId.value] : undefined
))

/** 当前服务的状态点样式 */
const currentServiceDot = computed(() => {
  const status = currentService.value?.status
  if (status === 'running') return 'is-active'
  if (status === 'failed') return 'is-error'
  return ''
})

/** 当前服务的中文状态 */
const currentServiceLabel = computed(() => {
  const status = currentService.value?.status
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'failed') return '异常'
  if (status === 'stopped') return '已停止'
  return '未启动'
})

/** 当前服务状态徽标样式 */
const currentServiceClass = computed(() => {
  const status = currentService.value?.status
  if (status === 'running') return 'tag-success'
  if (status === 'failed') return 'tag-danger'
  if (status === 'stopped') return ''
  return 'tag-warning'
})

/** 当前服务的端口文案 */
const currentPortLabel = computed(() => (
  currentService.value?.port ? `端口 ${currentService.value.port}` : '端口未分配'
))

/**
 * 当前 Story 对应的 CodeBuddy 实例 Web 入口。
 * 只有服务正在运行且已分配端口时才提供跳转，避免打开一个打不开的地址。
 * @returns 实例首页 URL；不可用时返回空字符串
 */
const currentServiceUrl = computed(() => {
  const service = currentService.value
  if (!service?.port || service.status !== 'running') return ''
  return `http://127.0.0.1:${service.port}/`
})

/** 当前 Story 的服务是否在运行；未运行时禁止创建实例/恢复会话 */
const currentServiceRunning = computed(() => currentService.value?.status === 'running')

/** 当前选中实例的状态徽标样式 */
const currentJobClass = computed(() => (selectedJob.value?.status === 'busy' ? 'tag-success' : ''))

/** 当前选中实例的状态文案 */
const currentJobLabel = computed(() => (selectedJob.value?.status === 'busy' ? '执行中' : '空闲'))

/** 当前选中实例的 session 摘要，长 ID 只保留尾段以便辨认 */
const currentJobSession = computed(() => {
  const sessionId = selectedJob.value?.sessionId
  if (!sessionId) return '无 session'
  return sessionId.length > 12 ? `session …${sessionId.slice(-8)}` : `session ${sessionId}`
})

/** 定时页是否一条任务都没有（用于空态提示） */
const cronGroupsEmpty = computed(() => crons.value.length === 0)
/** 运行中的任务数量 */
const activeCronCount = computed(() => crons.value.filter((cron) => cron.enabled === true).length)
/** 已暂停的任务数量 */
const pausedCronCount = computed(() => crons.value.filter((cron) => cron.enabled === false).length)

/**
 * 判断任务是否缺少必要配置或尚未完成归属校验。
 * @param cron 定时任务
 * @returns 需要处理时返回 true
 */
function cronNeedsAttention(cron: Cron): boolean {
  return !cron.storyId || !(cron.sessionId ?? cron.ownerSessionId)
}

/** 待完善配置的任务数量 */
const attentionCronCount = computed(() => crons.value.filter(cronNeedsAttention).length)

/**
 * 判断任务是否匹配当前关键词与状态筛选。
 * @param cron 定时任务
 * @param query 已转为小写的搜索关键词
 * @returns 匹配时返回 true
 */
function matchesCronFilters(cron: Cron, query: string): boolean {
  const matchesStatus = cronStatusFilter.value === 'all'
    || (cronStatusFilter.value === 'enabled' && cron.enabled === true)
    || (cronStatusFilter.value === 'paused' && cron.enabled === false)
    || (cronStatusFilter.value === 'attention' && cronNeedsAttention(cron))
  if (!matchesStatus) return false
  if (!query) return true
  const searchable = [cron.id, cron.storyTitle, cron.storyId, cron.cron, cron.promptFirstLine, cron.ownerSessionId]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
  return searchable.includes(query)
}

/** 应用搜索与状态筛选后的定时任务分组 */
const visibleCronGroups = computed<CronGroup[]>(() => {
  const query = cronQuery.value.trim().toLocaleLowerCase()
  const hasFilters = Boolean(query) || cronStatusFilter.value !== 'all'
  return cronGroups.value.map((group) => ({
    ...group,
    stories: group.stories.map((story) => ({
      ...story,
      crons: story.crons.filter((cron) => matchesCronFilters(cron, query)),
    })).filter((story) => story.crons.length > 0 || !hasFilters),
    looseCrons: group.looseCrons.filter((cron) => matchesCronFilters(cron, query)),
    unassignedCrons: group.unassignedCrons.filter((cron) => matchesCronFilters(cron, query)),
  })).filter((group) => group.stories.length > 0 || group.looseCrons.length > 0 || group.unassignedCrons.length > 0)
})

/** 当前筛选结果中的任务数量 */
const filteredCronCount = computed(() => visibleCronGroups.value.reduce((total, group) => (
  total + group.looseCrons.length + group.unassignedCrons.length
  + group.stories.reduce((storyTotal, story) => storyTotal + story.crons.length, 0)
), 0))

/** 是否已设置搜索或筛选条件 */
const cronHasActiveFilters = computed(() => Boolean(cronQuery.value.trim()) || cronStatusFilter.value !== 'all')

/** 清空定时任务搜索与状态筛选。 */
function resetCronFilters(): void {
  cronQuery.value = ''
  cronStatusFilter.value = 'all'
}

const pageHeading = computed(() => page.value === 'tools' ? '连接与配置' : String(route.meta.title ?? 'DevTask'))

watch([page, () => store.snapshot?.requirements.length], ([value]) => {
  if (value === 'workspaces') {
    void refreshRepositoryCandidates()
    void refreshWorkspaces()
  }
  if (value === 'instances') void refreshStoryServices()
  // 发布页按工作区列出项目，并按需拉取每个项目的 DevOps 只读数据
  if (value === 'releases') void prepareReleasePage()
}, { immediate: true })

// 看板以 TAPD 需求为数据元，与其他页面的本地快照分开拉取。
// 单独监听 page：若放进上面同时依赖 requirements.length 的 watch，首次快照到达时
// requirements.length 变化会再次触发，导致刷新页面重复请求看板接口。
watch(page, (value) => {
  if (value === 'board') void board.load()
}, { immediate: true })

// 刷新页面或直接进入深链接时，确保快照至少拉取一次，避免首屏空数据
onMounted(() => {
  void store.ensureLoaded()
  // 派发轮次决定能否再次派发，进入页面就要拿到
  void cronDispatches.refresh()
  // 运行期监督事件由后端巡检产生，页面按固定间隔拉取
  lifecycle.startEventPolling()
  // 多个实例并行时状态会变化，实例页按 20 秒轮询刷新；后台标签页不发起请求
  jobsPollTimer = setInterval(() => {
    if (page.value !== 'instances' || document.visibilityState !== 'visible') return
    void refreshStoryServices()
  }, 20_000)
})

watch([page, () => route.query.storyId], ([value, storyId]) => {
  if (value !== 'board' || typeof storyId !== 'string') return
  const requirement = store.snapshot?.requirements.find((row) => row.storyId === storyId)
  if (requirement) openRequirement(requirement)
})

watch(
  [workspaceName, selectedRepositoryNames, branch, baseBranch, skipInstall, skipGraphify],
  () => { previewResult.value = null },
  { deep: true },
)

onUnmounted(() => {
  cancelWorkspacePolling()
  if (jobsPollTimer) clearInterval(jobsPollTimer)
  jobStreamController?.abort()
  jobExtras.clearDetail()
  inboxAnswers.flushPending()
})

function openRequirement(requirement: Requirement): void {
  selectedRequirement.value = requirement
}

/**
 * 流水线定时节点跳转到定时任务页。
 * @returns Promise<void>，忽略导航结果
 */
function goCrons(): void {
  void router.push('/crons')
}

/**
 * 切换任务的启用状态。
 * @param cron 任务
 * @param enabled 目标状态
 * @returns Promise<void>
 */
async function toggleCron(cron: Cron, enabled: boolean): Promise<void> {
  await cronActions.toggle(cron, enabled)
}

/**
 * 打开编辑弹层。
 * @param cron 任务
 */
function openCronEditor(cron: Cron): void {
  editingCron.value = cron
  editorStoryId.value = cron.storyId ?? ''
  cronEditorError.value = ''
  cronEditorOpen.value = true
}

/**
 * 打开新建弹层。
 * @param storyId 目标 Story
 */
function openCronCreator(storyId: string): void {
  editingCron.value = null
  editorStoryId.value = storyId
  cronEditorError.value = ''
  cronEditorOpen.value = true
}

/** 新建弹层对应的 Story 与 TAPD 上下文；缺失处理人时使用看板当前处理人 */
const editorRequirement = computed(() => {
  const requirement = store.snapshot?.requirements.find((item) => item.storyId === editorStoryId.value)
  if (!requirement) return null
  const boardStory = board.stories.find((story) => story.storyId === requirement.tapdStoryId)
  return {
    ...requirement,
    owner: requirement.owner || boardStory?.owner || board.owner,
    tapdWorkspaceId: requirement.tapdWorkspaceId ?? defaultTapdWorkspaceId,
  }
})

/** 当前 Story 工作区中的 plans 绝对路径，供自动修复模板读取 harness 状态 */
const editorPlansDir = computed(() => {
  const cwd = storyServices.value[editorStoryId.value]?.cwd
  return cwd ? `${cwd.replaceAll('\\', '/').replace(/\/$/, '')}/.codebuddy/plans` : ''
})

/** 编辑弹层对应的 Story 是否有可用服务端口 */
const editorServiceReady = computed(() => storyServices.value[editorStoryId.value]?.status === 'running')

/**
 * 提交编辑弹层：新建走创建接口，编辑走更新接口。
 * @param payload 表达式与可选提示词
 * @returns Promise<void>
 */
async function submitCronEditor(payload: { cron: string; prompt?: string; mode?: CronMode }): Promise<void> {
  cronSaving.value = true
  cronEditorError.value = ''
  try {
    if (editingCron.value) {
      const ok = await cronActions.update(editingCron.value, payload)
      if (ok) cronEditorOpen.value = false
      return
    }
    const created = await apiRequest<{ taskId: string | null; warnings?: string[] }>('/api/v1/crons', {
      method: 'POST',
      body: JSON.stringify({
        storyId: editorStoryId.value,
        cron: payload.cron,
        prompt: payload.prompt,
        mode: payload.mode ?? 'query_only',
        durable: true,
        expiryDays: 30,
      }),
    })
    await store.refresh(true)
    await cronDispatches.refresh()
    cronEditorOpen.value = false
    // 上游创建成功但缺少归属配置时必须告知用户，否则任务会静默地没有 owner
    if (created?.warnings?.length) cronError.value = created.warnings.join('；')
  } catch (cause) {
    cronEditorError.value = cause instanceof Error ? cause.message : '保存定时任务失败。'
  } finally {
    cronSaving.value = false
  }
}

/**
 * 展开或收起行内执行记录。
 * @param cron 任务
 * @returns Promise<void>
 */
async function toggleCronExecutions(cron: Cron): Promise<void> {
  if (expandedCronId.value === cron.id) {
    expandedCronId.value = ''
    cronExecutions.reset()
    return
  }
  expandedCronId.value = cron.id
  await cronExecutions.load(cron.id)
}

/**
 * 续期任务。
 * @param cron 任务
 * @returns Promise<void>
 */
async function renewCron(cron: Cron): Promise<void> {
  await cronActions.renew(cron)
}

/**
 * 派发到独立 StoryRound 轮次。
 * @param cron 任务
 * @returns Promise<void>
 */
async function dispatchCron(cron: Cron): Promise<void> {
  const confirmed = window.confirm(
    `将任务「${cron.id}」派发为一个独立的 StoryRound Job（提示词 \`/start fixbugs ${cron.storyId}\`）？`,
  )
  if (confirmed) await cronActions.dispatch(cron)
}

/**
 * 读取任务当前未归档的派发轮次。
 * @param taskId 任务 ID
 * @returns 未归档轮次；没有时返回 undefined
 */
function openDispatchOf(taskId: string): { roundId: string; createdAt: string; label?: string } | undefined {
  const round = cronDispatches.openRoundOf(taskId)
  if (!round) return undefined
  return {
    roundId: round.roundId,
    createdAt: round.createdAt,
    ...(round.label ? { label: round.label } : {}),
  }
}

/**
 * 归档派发轮次；归档成功后该任务才能再次派发。
 * @param cron 任务
 * @param outcome 归档终态
 * @returns Promise<void>
 */
async function archiveCronRound(cron: Cron, outcome: DispatchOutcome): Promise<void> {
  const round = cronDispatches.openRoundOf(cron.id)
  if (!round) return
  const ok = await cronDispatches.archive(cron.id, round.roundId, outcome)
  cronError.value = ok ? '' : cronDispatches.error.value
}

/**
 * 删除任务（组件内已二次确认）。
 * @param cron 任务
 * @returns Promise<void>
 */
async function removeCron(cron: Cron): Promise<void> {
  expandedCronId.value = ''
  await cronActions.remove(cron)
}

/**
 * 复制文本到剪贴板。
 * @param text 待复制文本
 * @returns Promise<void>
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪贴板可能被浏览器策略禁用，失败时保持静默
  }
}

/**
 * 打开审计抽屉并刷新流水。
 * @returns Promise<void>
 */
async function openAuditTrail(): Promise<void> {
  auditOpen.value = true
  await auditTrail.refresh()
}

/**
 * 启动或接管 Story 服务。
 * @param requirement 需求
 * @returns Promise<void>
 */
/**
 * 打开某个 Story 的主会话总览。
 * 即使 Story 没有变化，也会退出当前 Job 子任务，保证左侧主会话始终可作为返回入口。
 * @param storyId Story 标识
 * @returns 无返回值
 */
function focusStory(storyId: string): void {
  selectedStoryId.value = storyId
  if (!selectedJob.value) return
  jobStreamController?.abort()
  selectedJob.value = null
  jobExtras.clearDetail()
  jobTranscript.value = ''
  jobOutput.value = ''
  jobError.value = ''
}

async function startStoryService(requirement: Requirement): Promise<void> {
  if (!requirement.workspacePath) return
  // 启动后把该 Story 设为当前上下文，右侧立刻显示它对应的服务信息
  if (!selectedJob.value) selectedStoryId.value = requirement.storyId
  await lifecycle.start(requirement.storyId)
  await loadStoryJobs()
}

/**
 * 停止 Story 服务（服务端会先暂停关联定时任务）。
 * @param storyId Story 标识
 * @returns Promise<void>
 */
async function stopStoryService(storyId: string): Promise<void> {
  await lifecycle.stop(storyId)
  await loadStoryJobs()
}

/**
 * 删除服务映射。
 * @param storyId Story 标识
 * @returns Promise<void>
 */
async function removeStoryService(storyId: string): Promise<void> {
  await lifecycle.remove(storyId)
  await loadStoryJobs()
}

/**
 * 刷新服务状态并重新加载已运行服务的实例列表。
 * @returns Promise<void>
 */
async function refreshStoryServices(): Promise<void> {
  await lifecycle.refresh()
  await loadStoryJobs()
}

/**
 * 拉取已运行 Story 下的实例列表。
 * @returns Promise<void>
 */
async function loadStoryJobs(): Promise<void> {
  const activeRequirements = storyServiceRequirements.value.filter(
    (requirement) => storyServices.value[requirement.storyId]?.status === 'running',
  )
  const jobLists = await Promise.all(activeRequirements.map(async (requirement) => {
    try {
      return await apiRequest<Job[]>(`/api/v1/stories/${encodeURIComponent(requirement.storyId)}/jobs`)
    } catch {
      return []
    }
  }))
  storyJobs.value = jobLists.flat()
}

/** Bug 修复轮次的补充口径：限定处理人与缺陷状态，并要求按查询+修复流程执行 */
const bugFixPromptSuffix = '处理人蔡杰鹏，缺陷状态待解决和重新打开，根据结果使用查询+修复按流程修复bug'

function prepareJob(requirement: Requirement, mode: 'run' | 'fixbugs'): void {
  selectedStoryId.value = requirement.storyId
  resumableSessions.value = []
  selectedResumableSession.value = ''
  jobName.value = `${requirement.title} · ${mode === 'run' ? '需求开发' : 'Bug 修复'}`
  // 修复模式在 harness 入口之后追加本次缺陷口径，避免把无关缺陷纳入本轮
  jobPrompt.value = mode === 'run'
    ? `/start ${requirement.storyId}`
    : `/start fixbugs ${requirement.storyId}\n${bugFixPromptSuffix}`
  jobError.value = ''
}

async function loadResumableSessions(requirement: Requirement): Promise<void> {
  selectedStoryId.value = requirement.storyId
  resumableLoading.value = true
  jobError.value = ''
  try {
    const result: unknown = await apiRequest(`/api/v1/stories/${encodeURIComponent(requirement.storyId)}/jobs/resumable`)
    resumableSessions.value = resumableSessionSchema.array().parse(result)
    selectedResumableSession.value = resumableSessions.value[0]?.sessionId ?? ''
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : 'Unable to list resumable sessions.'
  } finally {
    resumableLoading.value = false
  }
}

async function resumeSession(): Promise<void> {
  if (!selectedStoryId.value || !selectedResumableSession.value) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    await apiRequest(`/api/v1/stories/${encodeURIComponent(selectedStoryId.value)}/jobs/resume`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: selectedResumableSession.value }),
    })
    selectedJob.value = null
    await refreshStoryServices()
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : 'Unable to resume the session.'
  } finally {
    jobActionLoading.value = false
  }
}

/**
 * 从创建轮次的响应里解析出刚创建的实例。
 * CodeBuddy `POST /api/v1/jobs` 返回 `{ data: AgentJob }`，这里解包并补上 Story 归属。
 * @param payload 创建接口原始响应
 * @returns 可用于直接展示的实例；无法识别时返回 null
 */
function createdJobOf(payload: unknown): Job | null {
  const wrapped = payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data: unknown }).data
    : payload
  const candidate = typeof wrapped === 'object' && wrapped !== null ? wrapped : {}
  const parsed = jobSchema.safeParse({ ...candidate, storyId: selectedStoryId.value })
  return parsed.success ? parsed.data : null
}

async function createJob(): Promise<void> {
  if (!selectedStoryId.value || !jobName.value.trim() || !jobPrompt.value.trim()) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    const created = await apiRequest<unknown>(`/api/v1/stories/${encodeURIComponent(selectedStoryId.value)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ name: jobName.value.trim(), prompt: jobPrompt.value.trim() }),
    })
    await refreshStoryServices()
    // 创建成功后直接打开该轮次，用户能立刻看到它在跑，而不是「按钮闪一下就没下文」
    const job = createdJobOf(created)
    if (job) await openJob(job)
    await refreshStoryServices()
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : 'Unable to create the CodeBuddy job.'
  } finally {
    jobActionLoading.value = false
  }
}

async function openJob(job: Job): Promise<void> {
  jobStreamController?.abort()
  selectedJob.value = job
  // 同步记录实例所属 Story：右侧上下文与左侧高亮都依赖它，否则多服务并存时看不出在看哪个
  if (job.storyId) selectedStoryId.value = job.storyId
  // 详情与偏好都属于该 Story 的服务，随选中实例一起加载
  if (job.storyId) {
    void jobExtras.loadDetail(job.storyId, job.id)
    void jobExtras.loadPrefs(job.storyId)
  }
  renameDraft.value = job.name
  jobTranscript.value = ''
  jobOutput.value = ''
  jobError.value = ''
  const controller = new AbortController()
  jobStreamController = controller
  try {
    const transcript = await apiRequest<unknown>(
      `/api/v1/stories/${encodeURIComponent(job.storyId ?? '')}/jobs/${encodeURIComponent(job.id)}/transcript`,
    )
    jobTranscript.value = typeof transcript === 'string' ? transcript : JSON.stringify(transcript, null, 2)
    await streamJobOutput(job, controller)
  } catch (cause) {
    if (!controller.signal.aborted) {
      jobError.value = cause instanceof Error ? cause.message : 'Unable to load Job transcript or stream.'
    }
  }
}

async function streamJobOutput(job: Job, controller: AbortController): Promise<void> {
  const token = sessionStorage.getItem('devtask-console-token')
  let lastEventId = ''
  for (let attempt = 0; attempt < 5 && !controller.signal.aborted; attempt += 1) {
    try {
      const response = await fetch(
        `/api/v1/stories/${encodeURIComponent(job.storyId ?? '')}/jobs/${encodeURIComponent(job.id)}/stream`,
        {
          headers: {
            ...(token ? { 'x-devtask-token': token } : {}),
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
          },
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        throw new ApiError(`Unable to open Job stream (HTTP ${response.status}).`, response.status)
      }
      if (!response.body) throw new ApiError('Job stream has no response body.', 502)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          jobOutput.value = `${jobOutput.value}${chunk}`.slice(-200_000)
          const lines = `${pending}${chunk}`.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('id:')) lastEventId = line.slice(3).trim()
          }
        }
        const tail = decoder.decode()
        if (tail) jobOutput.value = `${jobOutput.value}${tail}`.slice(-200_000)
      } finally {
        reader.releaseLock()
      }
      if (isTerminalJob(job)) return
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status < 500) throw cause
      if (attempt === 4) throw cause
    }
    await waitForStreamRetry([1000, 2000, 5000, 10_000, 30_000][attempt] ?? 30_000, controller.signal)
  }
}

function isTerminalJob(job: Job): boolean {
  return ['done', 'failed', 'stopped'].includes(job.state) || job.status === 'stopped'
}

function waitForStreamRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * 从回复接口响应中取出用户可见的投递结果。
 * CodeBuddy 返回 `{ data: { delivered, saved, notice } }`：
 * delivered 表示活会话已立即收到，saved 表示已存为待消费回复（实例重启后继续）。
 * @param payload 原始响应
 * @returns 提示文案；无法识别时返回 undefined
 */
function replyNoticeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.notice === 'string' && record.notice) return record.notice
  if (record.delivered === true) return '已发送到实例。'
  if (record.saved === true) return '实例已退出，回复已保存；点「重启」后会继续处理。'
  return undefined
}

async function replyToJob(): Promise<void> {
  if (!selectedJob.value?.storyId || !jobReply.value.trim()) return
  const job = selectedJob.value
  const storyId = job.storyId
  if (!storyId) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    const result = await apiRequest<unknown>(`/api/v1/stories/${encodeURIComponent(storyId)}/jobs/${encodeURIComponent(job.id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text: jobReply.value.trim(), bash: false }),
    })
    jobTranscript.value += `\n\nYou: ${jobReply.value.trim()}`
    jobReply.value = ''
    actionToasts.notify(replyNoticeOf(result) ?? '回复已提交。', 'success')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '发送回复失败。'
    jobError.value = message
    actionToasts.notify(`回复失败：${message}`, 'error')
  } finally {
    jobActionLoading.value = false
  }
}

async function renameJob(): Promise<void> {
  const job = selectedJob.value
  if (!job?.storyId || !renameDraft.value.trim()) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    await apiRequest(`/api/v1/stories/${encodeURIComponent(job.storyId)}/jobs/${encodeURIComponent(job.id)}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name: renameDraft.value.trim() }),
    })
    selectedJob.value = { ...job, name: renameDraft.value.trim() }
    storyJobs.value = storyJobs.value.map((item) =>
      item.storyId === job.storyId && item.id === job.id ? { ...item, name: renameDraft.value.trim() } : item)
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : 'Unable to rename the instance.'
  } finally {
    jobActionLoading.value = false
  }
}

/** 实例写操作的中文动作名，用于结果提示 */
const jobActionLabels = { stop: '暂停', respawn: '重启', delete: '删除' } as const

async function controlJob(action: 'stop' | 'respawn' | 'delete'): Promise<void> {
  const job = selectedJob.value
  if (!job?.storyId) return
  const label = jobActionLabels[action]
  if (action === 'delete' && !window.confirm(`删除实例「${job.name}」？此操作不能撤销。`)) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    const jobPath = `/api/v1/stories/${encodeURIComponent(job.storyId)}/jobs/${encodeURIComponent(job.id)}`
    const result: unknown = await apiRequest(action === 'delete' ? jobPath : `${jobPath}/${action}`, {
      method: action === 'delete' ? 'DELETE' : 'POST',
    })
    if (action === 'delete') {
      if (typeof result !== 'object' || result === null || !('deleted' in result) || typeof result.deleted !== 'boolean') {
        throw new Error('CodeBuddy returned an invalid deletion response.')
      }
      if (!result.deleted) {
        const reason = 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : 'CodeBuddy did not delete the instance.'
        throw new Error(reason)
      }
      selectedJob.value = null
      jobExtras.clearDetail()
    }
    jobStreamController?.abort()
    // 操作完成后同时刷新左侧列表与右侧详情，状态不停留在旧值
    await refreshStoryServices()
    if (action !== 'delete') {
      const refreshed = storyJobs.value.find((item) => item.id === job.id && item.storyId === job.storyId)
      if (refreshed) {
        selectedJob.value = refreshed
        await jobExtras.loadDetail(job.storyId, job.id)
      } else if (action === 'respawn') {
        // 重启可能生成新的实例 ID，旧实例不在列表时退出详情回到列表
        selectedJob.value = null
        jobExtras.clearDetail()
      }
    }
    actionToasts.notify(`已${label}实例「${job.name}」`, 'success')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : `${label}实例失败。`
    jobError.value = message
    actionToasts.notify(`${label}实例失败：${message}`, 'error')
  } finally {
    jobActionLoading.value = false
  }
}

async function refreshRepositoryCandidates(): Promise<void> {
  candidatesLoading.value = true
  candidatesError.value = ''
  try {
    const result: unknown = await apiRequest('/api/v1/workspaces/candidates')
    repositoryCandidates.value = repositoryCandidateSchema.array().parse(result)
    const availableNames = new Set(repositoryCandidates.value.map((candidate) => candidate.name))
    selectedRepositoryNames.value = selectedRepositoryNames.value.filter((name) => availableNames.has(name))
    await loadApplicationMappings()
  } catch (cause) {
    candidatesError.value = cause instanceof Error ? cause.message : 'Repository discovery failed.'
  } finally {
    candidatesLoading.value = false
  }
}

/**
 * 读取已保存的差异映射。服务端只返回人工确认且与默认不一致的记录。
 * @returns Promise<void>，错误写入 mappingsError
 */
async function loadApplicationMappings(): Promise<void> {
  mappingsError.value = ''
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(
      await apiRequest<unknown>('/api/v1/application-mappings'),
    )
  } catch (cause) {
    mappingsError.value = cause instanceof Error ? cause.message : 'Unable to load application mappings.'
  }
}

/**
 * 打开映射表单：新增时清空草稿，编辑时只预填已发生变动的字段。
 * @param repoName 要编辑的仓库名；省略表示新增
 * @returns void
 */
function openMappingDialog(repoName?: string): void {
  mappingFormError.value = ''
  const saved = repoName ? applicationMappings.value.find((mapping) => mapping.repoName === repoName) : undefined
  const savedProjectId = saved?.gitlabProjectId
  mappingEditingRepo.value = saved ? saved.repoName : null
  const form = mappingForm.value
  form.repoName = saved?.repoName ?? ''
  form.gitlabProjectId = savedProjectId
  form.devopsApp = saved?.devopsApp !== undefined && saved.devopsApp !== saved.repoName ? saved.devopsApp : ''
  form.devopsGroup = saved?.devopsGroup !== undefined && saved.devopsGroup !== defaultDevOpsGroup
    ? saved.devopsGroup
    : ''
  // 编辑时已保存的项目 ID 需要一个占位选项，否则下拉无法显示已选值
  mappingProjectOptions.value = savedProjectId !== undefined
    ? [{ id: savedProjectId, pathWithNamespace: `GitLab 项目 #${savedProjectId}（已保存）` }]
    : []
  mappingDialogOpen.value = true
  if (form.repoName) void loadMappingProjectOptions(form.repoName)
}

/**
 * 关闭映射表单并清理草稿与搜索候选。
 * @returns void
 */
function closeMappingDialog(): void {
  mappingDialogOpen.value = false
  mappingEditingRepo.value = null
  mappingFormError.value = ''
  mappingProjectOptions.value = []
}

/**
 * 按关键字搜索 GitLab 项目，结果只作为人工选择候选，不写库也不自动采用。
 * 编辑态保留已保存项目的占位选项，避免搜索结果变化导致已选值丢失。
 * @param query 搜索关键字（通常为仓库名）
 * @returns Promise<void>，错误写入 mappingFormError
 */
async function loadMappingProjectOptions(query: string): Promise<void> {
  const keyword = query.trim()
  if (!keyword) {
    mappingProjectOptions.value = []
    return
  }
  mappingProjectsLoading.value = true
  try {
    const search = new URLSearchParams({ search: keyword })
    const result: unknown = await apiRequest(`/api/v1/gitlab/projects?${search}`)
    const projects = gitLabProjectSchema.array().parse(result)
    const savedProjectId = applicationMappings.value
      .find((mapping) => mapping.repoName === mappingEditingRepo.value)?.gitlabProjectId
    const savedOption = mappingProjectOptions.value.find((option) => option.id === savedProjectId)
    mappingProjectOptions.value = [
      ...(savedOption && !projects.some((project) => project.id === savedProjectId) ? [savedOption] : []),
      ...projects,
    ]
  } catch (cause) {
    mappingFormError.value = cause instanceof Error ? cause.message : 'GitLab project search failed.'
  } finally {
    mappingProjectsLoading.value = false
  }
}

/**
 * 提交新增或编辑的映射。与默认约定完全一致时拒绝写入，沿用默认即可。
 * @returns Promise<void>，错误写入 mappingFormError
 */
async function submitMappingForm(): Promise<void> {
  mappingFormError.value = ''
  const form = mappingForm.value
  const repoName = form.repoName.trim()
  if (!repoName || !mappingFormChanged.value) {
    mappingFormError.value = '与默认规则一致，无需单独保存；如需移除已有映射请点击「恢复默认」。'
    return
  }
  const input: ApplicationMapping = {
    repoName,
    devopsApp: form.devopsApp.trim() || repoName,
    devopsGroup: form.devopsGroup.trim() || defaultDevOpsGroup,
    ...(typeof form.gitlabProjectId === 'number'
      ? { gitlabProjectId: form.gitlabProjectId }
      : {}),
  }
  const parsed = applicationMappingSchema.safeParse(input)
  if (!parsed.success) {
    mappingFormError.value = parsed.error.issues.map((issue) => issue.message).join(' ')
    return
  }
  mappingSaving.value = true
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(await apiRequest<unknown>(
      '/api/v1/application-mappings',
      { method: 'PUT', body: JSON.stringify(parsed.data) },
    ))
    closeMappingDialog()
  } catch (cause) {
    mappingFormError.value = cause instanceof Error ? cause.message : 'Unable to save application mapping.'
  } finally {
    mappingSaving.value = false
  }
}

/**
 * 删除差异映射，使该仓库回到默认约定。
 * @param repoName git 仓库名
 * @returns Promise<void>，错误写入 mappingsError
 */
async function removeApplicationMapping(repoName: string): Promise<void> {
  mappingRemoving.value = repoName
  mappingsError.value = ''
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(await apiRequest<unknown>(
      `/api/v1/application-mappings/${encodeURIComponent(repoName)}`,
      { method: 'DELETE' },
    ))
  } catch (cause) {
    mappingsError.value = cause instanceof Error ? cause.message : 'Unable to remove application mapping.'
  } finally {
    mappingRemoving.value = ''
  }
}

function workspaceRequest(): Record<string, unknown> {
  return {
    workspaceName: workspaceName.value,
    repositoryNames: selectedRepositoryNames.value,
    ...(branch.value ? { branch: branch.value } : {}),
    ...(baseBranch.value ? { baseBranch: baseBranch.value } : {}),
    skipInstall: skipInstall.value,
    skipGraphify: skipGraphify.value,
  }
}

async function previewWorkspace(): Promise<void> {
  workspaceError.value = ''
  workspaceJob.value = null
  try {
    previewResult.value = workspacePreviewSchema.parse(await apiRequest<unknown>('/api/v1/workspaces/initialize/preview', {
      method: 'POST',
      body: JSON.stringify(workspaceRequest()),
    }))
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : 'DryRun failed.'
  }
}

async function startWorkspace(): Promise<void> {
  if (!workspaceName.value || !selectedRepositoryNames.value.length) {
    workspaceError.value = '请先填写工作区名并选择至少一个项目。'
    return
  }
  workspaceError.value = ''
  workspaceJob.value = null
  // 在 POST 发起前就作废旧轮询并置提交中：POST 飞行期间 workspaceJob 尚未赋值，
  // 仅靠 workspaceRunning 无法禁用按钮，必须靠 workspaceSubmitting 防止连点并发创建。
  cancelWorkspacePolling()
  // 记录本轮要绑定的 TAPD 输入，供 job 成功后写入；仅在填了链接时绑定。
  // 目标工作区名在此刻快照，避免回调的 await 期间被新一轮 job 覆盖导致写错工作区。
  const tapdStoryId = workspaceTapdInput.value.trim()
  pendingWorkspaceBinding = tapdStoryId
    ? { tapdStoryId, storyTitle: workspaceTapdTitle.value.trim(), workspaceName: workspaceName.value }
    : null
  workspaceSubmitting.value = true
  try {
    workspaceJob.value = workspaceInitializationJobSchema.parse(await apiRequest<unknown>('/api/v1/workspaces/initialize', {
      method: 'POST',
      body: JSON.stringify(workspaceRequest()),
    }))
    // 用自增后的最新令牌发起本轮轮询
    pollWorkspaceJob(workspaceJob.value.id, workspacePollGeneration)
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : 'Unable to start workspace initialization.'
  } finally {
    // 提交阶段结束；此后忙碌态由 job 的 running 状态接管
    workspaceSubmitting.value = false
  }
}

/**
 * 工作区变更（新建 / 续跑初始化成功）后统一刷新所有受影响视图数据。
 *
 * 工作区初始化会改变本地扫描结果，进而影响统一快照的 local 段、工作区列表、
 * 以及发布页使用的应用差异映射，因此三处数据一起更新：
 * store.refresh(true) 重建快照 local 段 + tapd + connectivity；
 * refreshWorkspaces() 刷新工作区列表；loadApplicationMappings() 刷新发布页映射。
 *
 * 三路并发执行。三者内部已各自 try/catch 并把错误写入对应 error ref，正常情况下
 * 不会 reject；此处用 Promise.allSettled 作防御性兜底——万一某路意外抛出，既不阻断
 * 其它两路，也通过 toast 给用户可见反馈，而不是只写控制台。
 *
 * @returns Promise<void>，永不 reject；常规失败信息由各函数自身的 error ref 呈现
 */
async function refreshAfterWorkspaceChange(): Promise<void> {
  // 工作区已真实存在：若本轮填写了 TAPD 链接，写入「工作区 ↔ TAPD 需求」绑定。
  // 绑定失败不回滚已创建的工作区，仅提示，用户仍可在看板补绑。
  const binding = pendingWorkspaceBinding
  pendingWorkspaceBinding = null
  if (binding) {
    try {
      await apiRequest('/api/v1/workspace-bindings', {
        method: 'PUT',
        body: JSON.stringify({
          tapdStoryId: binding.tapdStoryId,
          workspaceName: binding.workspaceName,
          ...(binding.storyTitle ? { storyTitle: binding.storyTitle } : {}),
        }),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '未知错误'
      actionToasts.notify(`工作区已创建，但绑定 TAPD 需求失败：${message}`, 'error')
    }
  }
  // 绑定改动只影响看板数据源，始终强制穿透文件缓存重新拉取，让新绑定即时可见。
  // board.load() 内部已 try/catch，失败仅写 board.error 由界面自证，不阻断其它刷新。
  await board.load(true)
  const results = await Promise.allSettled([
    store.refresh(true),
    refreshWorkspaces(),
    loadApplicationMappings(),
  ])
  const failed = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  if (failed.length) {
    const reasons = failed.map((item) => item.reason instanceof Error ? item.reason.message : '未知错误')
    actionToasts.notify(`工作区已创建，但部分数据刷新失败：${reasons.join('；')}`, 'error')
  }
}

/**
 * 轮询工作区初始化任务，直至进入终态。
 * 通过 generation 令牌保证只有最新一轮轮询的回调能写入状态并触发刷新：
 * 回调入口与请求返回后各校验一次，避免使用旧响应覆盖新 job 或触发多余刷新。
 *
 * @param jobId 初始化任务 ID
 * @param generation 发起本轮轮询时的代际令牌
 */
function pollWorkspaceJob(jobId: string, generation: number): void {
  if (workspacePollTimer) clearTimeout(workspacePollTimer)
  workspacePollTimer = setTimeout(async () => {
    // 令牌校验：代际不一致说明已被新一轮/关闭/卸载作废，直接丢弃
    if (generation !== workspacePollGeneration) return
    try {
      const next = workspaceInitializationJobSchema.parse(
        await apiRequest<unknown>(`/api/v1/workspaces/initialize/${jobId}`),
      )
      // 请求飞行期间可能已作废，二次校验，避免用旧响应覆盖新状态
      if (generation !== workspacePollGeneration) return
      workspaceJob.value = next
      if (next.status === 'running') {
        // 递归沿用同一令牌
        pollWorkspaceJob(jobId, generation)
      } else if (next.status === 'succeeded') {
        // 工作区初始化改了本地扫描结果，统一刷新快照、工作区列表与发布页映射
        await refreshAfterWorkspaceChange()
      }
      // failed / interrupted 等其它终态：仅更新 workspaceJob，不触发刷新（沿用原行为）
    } catch (cause) {
      workspaceError.value = cause instanceof Error ? cause.message : 'Unable to read initialization progress.'
    }
  }, 1000)
}

/** 初始化任务是否可续跑：中断或失败，且保存了原始参数 */
const canResumeWorkspaceJob = computed(() => {
  const job = workspaceJob.value
  if (!job) return false
  if (job.status !== 'interrupted' && job.status !== 'failed') return false
  return Boolean(job.request)
})

/**
 * 续跑中断的初始化任务。
 * 服务端以同一参数重放幂等脚本，无法重新附着原进程，因此需要显式确认。
 * @returns Promise<void>
 */
async function resumeWorkspaceJob(): Promise<void> {
  const job = workspaceJob.value
  if (!job) return
  workspaceError.value = ''
  // 与新建一致：POST 前作废旧轮询并置提交中，防止续跑请求飞行期间重复操作
  cancelWorkspacePolling()
  workspaceSubmitting.value = true
  try {
    workspaceJob.value = workspaceInitializationJobSchema.parse(await apiRequest<unknown>(
      `/api/v1/workspaces/initialize/${job.id}/resume`,
      { method: 'POST', body: JSON.stringify({ acknowledgeRerun: true }) },
    ))
    pollWorkspaceJob(job.id, workspacePollGeneration)
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : '续跑初始化任务失败。'
  } finally {
    workspaceSubmitting.value = false
  }
}

/* ------------------------- 工作区管理：列表 / 详情 / 删除 ------------------------- */

/**
 * 拉取工作区列表（含每个工作区包含的项目及其分支）。
 * @returns Promise<void>，失败信息写入 workspacesError
 */
async function refreshWorkspaces(): Promise<void> {
  workspacesLoading.value = true
  workspacesError.value = ''
  try {
    const result: unknown = await apiRequest('/api/v1/workspaces')
    workspaces.value = workspaceSummarySchema.array().parse(result)
    // 抽屉打开时同步刷新详情，避免删除/新建后展示旧数据
    const current = selectedWorkspace.value
    if (current) {
      selectedWorkspace.value = workspaces.value.find((item) => item.name === current.name) ?? null
    }
  } catch (cause) {
    workspacesError.value = cause instanceof Error ? cause.message : '工作区列表加载失败。'
  } finally {
    workspacesLoading.value = false
  }
}

/**
 * 打开工作区详情抽屉。
 * @param workspace 列表中被点击的工作区
 */
function openWorkspaceDetail(workspace: WorkspaceSummary): void {
  selectedWorkspace.value = workspace
  // 切换工作区后上一次的创建结果不再适用，避免误读其它工作区的 MR 链接
  workspaceMergeRequestResult.value = null
  workspaceMergeRequestError.value = ''
  mrTargetBranch.value = defaultMergeRequestTargetBranch
}

/**
 * 为工作区内的项目创建合并请求（源分支 = 项目当前检出分支）。
 * 不传项目名表示一键创建：对工作区内全部项目同时发起。
 * @param projects 指定项目名清单；缺省表示全部项目
 * @returns Promise<void>
 */
async function createWorkspaceMergeRequest(projects?: string[]): Promise<void> {
  const workspace = selectedWorkspace.value
  if (!workspace || mrBusy.value) return
  const names = projects ?? workspace.projects.map((project) => project.name)
  if (!names.length) return

  workspaceMergeRequestError.value = ''
  workspaceMergeRequestResult.value = null
  mrCreatingProjects.value = names
  mrBatchRunning.value = projects === undefined
  try {
    const result: unknown = await apiRequest(
      `/api/v1/workspaces/${encodeURIComponent(workspace.name)}/merge-requests`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetBranch: mrTargetBranch.value,
          ...(projects ? { projects } : {}),
        }),
      },
    )
    const parsed = workspaceMergeRequestCreateResultSchema.parse(result)
    workspaceMergeRequestResult.value = parsed

    const created = parsed.items.filter((item) => item.status === 'created').length
    const exists = parsed.items.filter((item) => item.status === 'exists').length
    const failedItems = parsed.items.filter((item) => item.status === 'failed')
    if (failedItems.length) {
      workspaceMergeRequestError.value = failedItems
        .map((item) => `${item.project}：${item.message ?? '创建失败'}`)
        .join('；')
    }
    actionToasts.notify(
      `合并请求处理完成：新建 ${created} 个，已存在 ${exists} 个${failedItems.length ? `，失败 ${failedItems.length} 个` : ''}`,
      failedItems.length ? 'error' : 'success',
    )
  } catch (cause) {
    workspaceMergeRequestError.value = cause instanceof Error ? cause.message : '创建合并请求失败。'
    actionToasts.notify(`创建合并请求失败：${workspaceMergeRequestError.value}`, 'error')
  } finally {
    mrCreatingProjects.value = []
    mrBatchRunning.value = false
  }
}

/** 重置新建表单并打开新建弹窗。 */
function openCreateDialog(): void {
  // 作废旧 job 的在途回调，避免重复打开弹窗时被上一轮轮询覆盖状态或触发多余刷新
  cancelWorkspacePolling()
  workspaceName.value = ''
  branch.value = ''
  baseBranch.value = ''
  selectedRepositoryNames.value = []
  skipInstall.value = false
  skipGraphify.value = false
  workspaceTapdInput.value = ''
  workspaceTapdTitle.value = ''
  pendingWorkspaceBinding = null
  previewResult.value = null
  workspaceJob.value = null
  workspaceError.value = ''
  createDialogOpen.value = true
}

/** 关闭新建弹窗；提交中或初始化任务运行中时禁止关闭，避免丢失进度。 */
function closeCreateDialog(): void {
  if (workspaceBusy.value) return
  cancelWorkspacePolling()
  createDialogOpen.value = false
}

/**
 * el-dialog 关闭前的守卫：提交中或初始化任务运行中不允许关闭。
 * 忙碌时不再静默忽略，而是给出可见提示，避免 ESC / 遮罩关闭无反应让用户误以为卡死。
 * @param done 允许关闭时调用的回调
 */
function beforeCreateDialogClose(done: () => void): void {
  if (workspaceBusy.value) {
    actionToasts.notify('工作区初始化进行中，请等待完成后再关闭。', 'error')
    return
  }
  cancelWorkspacePolling()
  done()
}

/**
 * 打开删除确认弹窗。
 * @param workspace 待删除的工作区
 */
function openDeleteDialog(workspace: WorkspaceSummary): void {
  workspacePendingDelete.value = workspace
  deleteConfirmText.value = ''
  deleteError.value = ''
  deleteResult.value = null
  deleteDialogOpen.value = true
}

/** 关闭删除确认弹窗并重置输入。 */
function closeDeleteDialog(): void {
  if (deleting.value) return
  deleteDialogOpen.value = false
  workspacePendingDelete.value = null
  deleteConfirmText.value = ''
}

/**
 * 执行工作区删除：后端移除 git worktree 登记并删除工作区目录，不删除远程分支。
 * @returns Promise<void>
 */
async function confirmDeleteWorkspace(): Promise<void> {
  const workspace = workspacePendingDelete.value
  if (!workspace || !canConfirmDelete.value || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  deleteResult.value = null
  try {
    const result: unknown = await apiRequest<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspace.name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmText: deleteConfirmationPhrase }),
    })
    deleteResult.value = workspaceDeleteResultSchema.parse(result)
    if (selectedWorkspace.value?.name === workspace.name) selectedWorkspace.value = null
    await refreshWorkspaces()
  } catch (cause) {
    deleteError.value = cause instanceof Error ? cause.message : '工作区删除失败。'
  } finally {
    deleting.value = false
  }
}

/* ------------------------- 发布页：按工作区构建与创建 MR ------------------------- */

/** 发布页的 6 档构建环境，顺序即分段器展示顺序 */
const buildEnvironments: readonly BuildEnvironment[] = ['dev', 'test', 'pre', 'pre-txnj', 'prod-txnj', 'prod']
/** 当前选中的构建环境 */
const selectedBuildEnv = ref<BuildEnvironment>('dev')
/** DevOps 数据是否连接：取统一快照的通道状态 */
const devopsOk = computed(() => store.snapshot?.channels.devops?.ok ?? false)
/**
 * 当前是否处于 Harness Phase 4-6 门控区间：该区间发布写操作硬禁用，由发布助手负责。
 */
const releaseGatePhase = computed<number | undefined>(() => {
  const phases = (store.snapshot?.harnessActive ?? [])
    .map((active) => active.phase)
    .filter((phase): phase is number => typeof phase === 'number' && phase >= 4 && phase <= 6)
  return phases.length ? Math.min(...phases) : undefined
})
/** 构建写操作是否可用：门控未命中 + DevOps 已连接 */
const buildAllowed = computed(() => !releaseGatePhase.value && devopsOk.value)
/** 构建不可用的原因文案（用于按钮 tooltip 与横幅），可用时为空 */
const buildBlockReason = computed(() => {
  if (releaseGatePhase.value !== undefined) {
    return `Harness 正在执行 Phase ${releaseGatePhase.value}，由发布助手负责；此阶段禁止触发构建与创建 MR。`
  }
  if (!devopsOk.value) return 'DevOps 通道不可用，无法触发构建或创建 MR；请到「连接与配置」检查会话。'
  return ''
})

/**
 * 取环境固定口径（分支 / build_other / MR 目标分支），模板通过函数访问。
 * @param env 环境标识
 * @returns 环境固定参数
 */
function envSpecOf(env: BuildEnvironment): BuildEnvironmentSpec {
  return buildEnvironmentSpecs[env]
}

/**
 * 取环境对应的 build_other 值（模板通过函数访问）。
 * @param env 环境标识
 * @returns build_other 字符串
 */
function buildOtherOf(env: BuildEnvironment): string {
  return buildEnvironmentSpecs[env].buildOther
}

/**
 * 取环境对应的构建分支（模板通过函数访问）。
 * @param env 环境标识
 * @returns origin/xxx 形式的分支
 */
function branchOfEnv(env: BuildEnvironment): string {
  return buildEnvironmentSpecs[env].branch
}

/** 二次确认弹窗：待构建的清单（每项 = 一个应用） */
interface BuildConfirmItem {
  workspace: string
  project: string
  group: string
  app: string
}
/** 二次确认弹窗开关 */
const buildConfirmOpen = ref(false)
/** 二次确认弹窗展示的构建清单 */
const buildConfirmItems = ref<BuildConfirmItem[]>([])
/** 正在提交构建的应用集合（真实回执前禁用重复点击） */
const buildingApps = ref<string[]>([])
/** 构建结果汇总：逐应用记录成功/失败 */
interface BuildOutcome {
  app: string
  ok: boolean
  message: string
  number?: string
}
const buildOutcomes = ref<BuildOutcome[]>([])

/**
 * 计算某项目最终用于构建的 DevOps 应用名：优先人工映射，否则沿用仓库名。
 * @param projectName 项目/仓库名
 * @returns DevOps 应用名
 */
function devopsAppOf(projectName: string): string {
  return applicationMappings.value.find((mapping) => mapping.repoName === projectName)?.devopsApp ?? projectName
}

/**
 * 计算某项目最终用于构建的 DevOps 分组：优先人工映射，否则用默认分组。
 * @param projectName 项目/仓库名
 * @returns DevOps 分组名
 */
function devopsGroupOf(projectName: string): string {
  return applicationMappings.value.find((mapping) => mapping.repoName === projectName)?.devopsGroup ?? defaultDevOpsGroup
}

/**
 * 切换构建环境时只需更新选中项；无锁状态可清理。
 * @param env 目标环境
 */
function selectBuildEnv(env: BuildEnvironment): void {
  selectedBuildEnv.value = env
}

/**
 * 打开二次确认弹窗：逐项列出即将构建的应用，用户核对后才提交。
 * @param items 待构建清单
 */
function openBuildConfirm(items: BuildConfirmItem[]): void {
  buildConfirmItems.value = items
  buildOutcomes.value = []
  buildConfirmOpen.value = true
}

/**
 * 为单个项目打开构建确认。
 * @param workspace 工作区名
 * @param project 项目名
 */
function requestSingleBuild(workspace: string, project: string): void {
  openBuildConfirm([{
    workspace,
    project,
    group: devopsGroupOf(project),
    app: devopsAppOf(project),
  }])
}

/**
 * 收集某工作区中可构建的项目清单。
 * @param workspaceName 工作区名
 * @returns 构建清单
 */
function collectBuildItems(workspaceName: string): BuildConfirmItem[] {
  const workspace = workspaces.value.find((item) => item.name === workspaceName)
  if (!workspace) return []
  return workspace.projects.map((project) => ({
    workspace: workspace.name,
    project: project.name,
    group: devopsGroupOf(project.name),
    app: devopsAppOf(project.name),
  }))
}

/**
 * 为整个工作区的所有项目打开一键构建确认。
 * @param workspace 工作区名
 */
function requestWorkspaceBuild(workspace: string): void {
  const items = collectBuildItems(workspace)
  if (!items.length) {
    actionToasts.notify(`工作区「${workspace}」没有项目，无法构建。`, 'error')
    return
  }
  openBuildConfirm(items)
}

/** 二次确认是否可提交：仅在途时禁用 */
const canSubmitBuild = computed(() => buildingApps.value.length === 0)

/**
 * 真正提交构建：逐应用串行请求，等每个真实回执后再推进，不乐观更新。
 * 分支、build_other、env 字段完全由后端按所选环境固定映射决定。
 * @returns Promise<void>
 */
async function submitBuilds(): Promise<void> {
  if (!canSubmitBuild.value) return
  const env = selectedBuildEnv.value
  buildOutcomes.value = []
  for (const item of buildConfirmItems.value) {
    buildingApps.value.push(item.app)
    try {
      const result = buildTriggerResultSchema.parse(await apiRequest<unknown>('/api/v1/devops/build', {
        method: 'POST',
        body: JSON.stringify({ group: item.group, app: item.app, env }),
      }))
      buildOutcomes.value.push({
        app: item.app,
        ok: true,
        message: result.number ? `构建号 ${result.number}` : '已提交构建',
        ...(result.number ? { number: result.number } : {}),
      })
    } catch (cause) {
      buildOutcomes.value.push({
        app: item.app,
        ok: false,
        message: cause instanceof Error ? cause.message : '触发构建失败。',
      })
    } finally {
      buildingApps.value = buildingApps.value.filter((name) => name !== item.app)
    }
  }
  const failed = buildOutcomes.value.filter((outcome) => !outcome.ok).length
  actionToasts.notify(
    failed ? `构建完成：成功 ${buildOutcomes.value.length - failed} 个，失败 ${failed} 个。` : `构建已提交：${buildOutcomes.value.length} 个。`,
    failed ? 'error' : 'success',
  )
}

/**
 * 判断某应用当前是否正在提交构建。
 * @param app DevOps 应用名
 * @returns 提交中返回 true
 */
function isAppBuilding(app: string): boolean {
  return buildingApps.value.includes(app)
}

/* ------------------------- 发布页：创建 MR ------------------------- */

/** 当前正在创建 MR 的「工作区/项目」键集合 */
const releaseMrCreating = ref<string[]>([])
/** 创建 MR 的错误提示 */
const releaseMrError = ref('')
/** 创建 MR 结果弹窗开关 */
const releaseMrDialogOpen = ref(false)
/** 创建 MR 结果弹窗展示的项（含可打开的 MR 链接） */
const releaseMrDialogItems = ref<WorkspaceMergeRequestCreateItem[]>([])

/**
 * 生成一项 MR 结果的键。
 * @param workspace 工作区名
 * @param project 项目名
 * @returns 唯一键
 */
function mrKey(workspace: string, project: string): string {
  return `${workspace}/${project}`
}

/**
 * 在发布页为指定项目创建 MR：源分支取项目检出分支，目标分支跟随顶部所选环境。
 * 不传项目名表示对该工作区全部项目批量创建。
 * 成功后弹出结果对话框列出 MR 链接，支持新窗口打开。
 * @param workspace 工作区名
 * @param projects 指定项目名清单；缺省表示工作区全部
 * @returns Promise<void>
 */
async function createReleaseMr(workspace: string, projects?: string[]): Promise<void> {
  if (releaseMrCreating.value.length || !buildAllowed.value) return
  const names = projects ?? (workspaces.value.find((item) => item.name === workspace)?.projects.map((project) => project.name) ?? [])
  if (!names.length) return
  releaseMrError.value = ''
  releaseMrCreating.value.push(...names.map((name) => mrKey(workspace, name)))
  try {
    const result: unknown = await apiRequest(
      `/api/v1/workspaces/${encodeURIComponent(workspace)}/merge-requests`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetBranch: buildEnvironmentSpecs[selectedBuildEnv.value].mrTargetBranch,
          projects: names,
        }),
      },
    )
    const parsed = workspaceMergeRequestCreateResultSchema.parse(result)
    const failed = parsed.items.filter((item) => item.status === 'failed')
    if (failed.length) {
      releaseMrError.value = failed.map((item) => `${item.project}：${item.message ?? '创建失败'}`).join('；')
    }
    const succeeded = parsed.items.filter((item) => item.status !== 'failed')
    if (succeeded.length) {
      releaseMrDialogItems.value = succeeded
      releaseMrDialogOpen.value = true
    }
    actionToasts.notify(
      failed.length
        ? `合并请求处理完成：成功 ${succeeded.length} 个，失败 ${failed.length} 个。`
        : `合并请求处理完成：${succeeded.length} 个。`,
      failed.length ? 'error' : 'success',
    )
  } catch (cause) {
    releaseMrError.value = cause instanceof Error ? cause.message : '创建合并请求失败。'
    actionToasts.notify(`创建合并请求失败：${releaseMrError.value}`, 'error')
  } finally {
    releaseMrCreating.value = releaseMrCreating.value.filter((key) => !names.some((name) => key === mrKey(workspace, name)))
  }
}

/**
 * MR 结果状态文案（结果弹窗用）。
 * @param status 结果状态
 * @returns 中文文案
 */
function releaseMrStatusLabel(status: WorkspaceMergeRequestCreateItem['status']): string {
  return status === 'created' ? '已创建' : status === 'exists' ? '已存在' : '失败'
}

/**
 * MR 结果状态样式类（结果弹窗用）。
 * @param status 结果状态
 * @returns 标签样式类
 */
function releaseMrStatusClass(status: WorkspaceMergeRequestCreateItem['status']): string {
  return status === 'created' ? 'tag-success' : status === 'exists' ? 'tag-warning' : 'tag-danger'
}

/**
 * 进入发布页时加载差异映射与工作区列表。
 * @returns Promise<void>
 */
async function prepareReleasePage(): Promise<void> {
  await Promise.all([loadApplicationMappings(), refreshWorkspaces()])
}

/**
 * 格式化时间为本地可读文本。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无值时返回 '未知'
 */
function formatWorkspaceTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '未知'
}
  return {
    route,
    defaultDevOpsGroup,
    deleteConfirmationPhrase,
    mergeRequestTargetBranches,
    imageUploading,
    buildEnvironments,
    router,
    store,
    board,
    selectedRequirement,
    selectedBugs,
    selectedHarnessBugs,
    selectedQuestions,
    tapdAvailable,
    snapshotLoaded,
    snapshotLoading,
    refreshSnapshot,
    refreshSegments,
    refreshCurrentPage,
    detailOpen,
    search,
    repositoryCandidates,
    selectedRepositoryNames,
    applicationMappings,
    mappingDialogOpen,
    mappingEditingRepo,
    mappingForm,
    mappingProjectOptions,
    mappingProjectsLoading,
    mappingFormError,
    mappingSaving,
    mappingRemoving,
    candidatesLoading,
    candidatesError,
    mappingsError,
    mappingRows,
    mappingRepoOptions,
    mappingDialogTitle,
    mappingFormChanged,
    canSubmitMappingForm,
    showNoRepositoryHint,
    workspaceName,
    branch,
    baseBranch,
    skipInstall,
    skipGraphify,
    workspaceTapdInput,
    workspaceTapdTitle,
    pendingWorkspaceBinding,
    previewResult,
    workspaceJob,
    workspaceError,
    workspaces,
    workspacesLoading,
    workspacesError,
    selectedWorkspace,
    createDialogOpen,
    deleteDialogOpen,
    workspacePendingDelete,
    deleteConfirmText,
    deleting,
    deleteError,
    deleteResult,
    mrTargetBranch,
    mrCreatingProjects,
    mrBatchRunning,
    workspaceMergeRequestResult,
    workspaceMergeRequestError,
    mrBusy,
    mergeRequestStatusLabel,
    mergeRequestStatusClass,
    workspaceDetailOpen,
    canConfirmDelete,
    workspaceLogs,
    workspaceRunning,
    workspaceSubmitting,
    workspaceBusy,
    selectedRepositoryLabel,
    lifecycle,
    storyServices,
    startingStoryService,
    storyServiceError,
    activeServiceEvents,
    hasServiceFailure,
    dismissServiceEvent,
    serviceErrorOf,
    actionToasts,
    actionToastItems,
    dismissActionToast,
    inboxAnswers,
    inboxAnswerMap,
    inboxExpandedId,
    jobExtras,
    jobDetail,
    jobDetailLoading,
    jobDetailError,
    jobPinSaving,
    jobPrefsError,
    jobStateFilter,
    storyJobs,
    selectedJob,
    selectedStoryId,
    resumableSessions,
    selectedResumableSession,
    resumableLoading,
    jobName,
    renameDraft,
    jobPrompt,
    jobReply,
    jobTranscript,
    jobOutput,
    jobError,
    jobActionLoading,
    cronError,
    cronQuery,
    cronStatusFilter,
    cronDispatches,
    cronActions,
    cronExecutions,
    expandedCronId,
    cronEditorOpen,
    editingCron,
    editorStoryId,
    cronSaving,
    cronEditorError,
    auditOpen,
    auditTrail,
    cronExecutionRows,
    cronExecutionsLoading,
    cronExecutionsError,
    cronExecutionsSource,
    cronExecutionsWarning,
    cronExecutionsHasMore,
    cronNotices,
    cronBusyTaskId,
    auditEntries,
    auditLoading,
    auditError,
    auditUndoingId,
    loadCronExecutions,
    loadMoreCronExecutions,
    refreshAuditTrail,
    undoAuditEntry,
    undoCronAction,
    dismissCronNotice,
    jobStreamController,
    jobsPollTimer,
    workspacePollTimer,
    workspacePollGeneration,
    cancelWorkspacePolling,
    page,
    requirements,
    inbox,
    inboxGroups,
    questionSuggestions,
    suggestionOf,
    suggestionSegmentsOf,
    storyAnswerCount,
    redundantInboxReason,
    inboxReasonOf,
    setInboxAnswer,
    toggleInboxAnswer,
    inboxAnswerText,
    copyStoryAnswers,
    crons,
    jobs,
    storyServiceRequirements,
    workspacePipelines,
    pipelineStoryCount,
    assignedCronIds,
    unassignedCrons,
    activeWorkflows,
    describeChannelError,
    boardErrorHint,
    boardStatusTag,
    channelRows,
    codebuddyChannelView,
    channelUnavailable,
    jobsByStory,
    isMainSessionSelected,
    hasSelectedJob,
    isJobSelected,
    jobDotClass,
    jobStateLabel,
    jobMatchesFilter,
    selectedJobPinned,
    toggleSelectedJobPin,
    useSuggestedReply,
    handleStoryFileUpload,
    onPromptFileChange,
    onReplyFileChange,
    instanceGroups,
    emptyWorkspaceGuides,
    storyDraft,
    storyCreateError,
    storyCreating,
    selectedEmptyGroupKey,
    storyTargetWorkspace,
    storyTapdBinding,
    storyBindingGeneration,
    selectEmptyWorkspace,
    cancelStoryCreate,
    submitStoryCreate,
    cronGroups,
    currentStory,
    currentService,
    currentServiceDot,
    currentServiceLabel,
    currentServiceClass,
    currentPortLabel,
    currentServiceUrl,
    currentServiceRunning,
    currentJobClass,
    currentJobLabel,
    currentJobSession,
    cronGroupsEmpty,
    activeCronCount,
    pausedCronCount,
    cronNeedsAttention,
    attentionCronCount,
    matchesCronFilters,
    visibleCronGroups,
    filteredCronCount,
    cronHasActiveFilters,
    resetCronFilters,
    pageHeading,
    openRequirement,
    goCrons,
    toggleCron,
    openCronEditor,
    openCronCreator,
    editorRequirement,
    editorPlansDir,
    editorServiceReady,
    submitCronEditor,
    toggleCronExecutions,
    renewCron,
    dispatchCron,
    openDispatchOf,
    archiveCronRound,
    removeCron,
    copyText,
    openAuditTrail,
    focusStory,
    startStoryService,
    stopStoryService,
    removeStoryService,
    refreshStoryServices,
    loadStoryJobs,
    prepareJob,
    loadResumableSessions,
    resumeSession,
    createdJobOf,
    createJob,
    openJob,
    streamJobOutput,
    isTerminalJob,
    waitForStreamRetry,
    replyNoticeOf,
    replyToJob,
    renameJob,
    controlJob,
    refreshRepositoryCandidates,
    loadApplicationMappings,
    openMappingDialog,
    closeMappingDialog,
    loadMappingProjectOptions,
    submitMappingForm,
    removeApplicationMapping,
    workspaceRequest,
    previewWorkspace,
    startWorkspace,
    refreshAfterWorkspaceChange,
    pollWorkspaceJob,
    canResumeWorkspaceJob,
    resumeWorkspaceJob,
    refreshWorkspaces,
    openWorkspaceDetail,
    createWorkspaceMergeRequest,
    openCreateDialog,
    closeCreateDialog,
    beforeCreateDialogClose,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDeleteWorkspace,
    selectedBuildEnv,
    devopsOk,
    releaseGatePhase,
    buildAllowed,
    buildBlockReason,
    envSpecOf,
    buildOtherOf,
    branchOfEnv,
    buildConfirmOpen,
    buildConfirmItems,
    buildingApps,
    buildOutcomes,
    devopsAppOf,
    devopsGroupOf,
    selectBuildEnv,
    openBuildConfirm,
    requestSingleBuild,
    collectBuildItems,
    requestWorkspaceBuild,
    canSubmitBuild,
    submitBuilds,
    isAppBuilding,
    releaseMrCreating,
    releaseMrError,
    releaseMrDialogOpen,
    releaseMrDialogItems,
    mrKey,
    createReleaseMr,
    releaseMrStatusLabel,
    releaseMrStatusClass,
    prepareReleasePage,
    formatWorkspaceTime,
  }
}
