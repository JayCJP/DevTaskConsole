<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Files } from '@element-plus/icons-vue'
import {
  applicationMappingSchema,
  defaultDevOpsGroup,
  mergeRequestSchema,
  repositoryCandidateSchema,
  resumableSessionSchema,
  workspaceDeleteResultSchema,
  workspaceInitializationJobSchema,
  workspacePreviewSchema,
  workspaceSummarySchema,
  type Requirement,
  type ApplicationMapping,
  type Cron,
  type InboxItem,
  type Job,
  type MergeRequest,
  type RepositoryCandidate,
  type WorkspaceDeleteResult,
  type WorkspaceInitializationJob,
  type WorkspacePipeline,
  type WorkspacePreview,
  type WorkspaceSummary,
} from '@devtask/shared'
import { z } from 'zod'
import { useRoute } from 'vue-router'
import { ApiError, apiRequest } from '../api/client'
import CronTaskRow from '../components/CronTaskRow.vue'
import { useBoardStories } from '../composables/useBoardStories'
import { useConsoleStore } from '../stores/console'
import { filterOwnBuilds, filterOwnMergeRequests } from '../utils/release-filter'

const route = useRoute()
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
 * @returns Promise<void>
 */
async function refreshSnapshot(): Promise<void> {
  await store.refresh()
}
const gitLabProjectSchema = z.object({ id: z.number().int().positive(), pathWithNamespace: z.string() })
const mergeRequestDetailsSchema = z.object({
  approvals: z.object({ approved: z.boolean(), approvedBy: z.array(z.string()) }),
  changesCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
})
const detailOpen = computed({
  get: () => selectedRequirement.value !== null,
  set: (open: boolean) => {
    if (!open) selectedRequirement.value = null
  },
})
const search = ref('')
const repositoryCandidates = ref<RepositoryCandidate[]>([])
const selectedRepositoryNames = ref<string[]>([])
const applicationMappings = ref<ApplicationMapping[]>([])
/** 每个仓库的映射草稿：只有与“同名默认”不一致时才需要保存 */
const mappingDrafts = ref<Record<string, {
  gitlabProjectId?: number
  devopsApp: string
  devopsGroup: string
  projects: Array<{ id: number; pathWithNamespace: string }>
  loadingProjects: boolean
  saving: boolean
  /** 是否已保存过差异映射 */
  saved: boolean
  error: string
}>>({})
const candidatesLoading = ref(false)
const candidatesError = ref('')
const mappingsError = ref('')
const workspaceName = ref('')
const branch = ref('')
const baseBranch = ref('')
const skipInstall = ref(false)
const skipGraphify = ref(false)
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

/** 已选项目数量的展示文案 */
const selectedRepositoryLabel = computed(() => `已选择 ${selectedRepositoryNames.value.length} 个`)
const storyServices = ref<Record<string, { status: string; updatedAt: string; error?: string }>>({})
const startingStoryService = ref<string | null>(null)
const storyServiceError = ref('')
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
const jobTranscript = ref('')
const jobOutput = ref('')
const jobError = ref('')
const jobActionLoading = ref(false)
const selectedMergeRequest = ref<MergeRequest | null>(null)
const mergeRequestLoading = ref(false)
const mergeRequestError = ref('')
const cronMappingDrafts = ref<Record<string, {
  storyId: string
  ownerSessionId: string
  mode: '' | 'query_only' | 'query_fix'
  saving: boolean
  error: string
}>>({})
let jobStreamController: AbortController | undefined
let workspacePollTimer: ReturnType<typeof setTimeout> | undefined
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
  /** 工作区名（工作区目录名） */
  name: string
  /** 工作区下的仓库 worktree 路径，仅当比工作区名更具体时展示 */
  pathHint: string
  itemCount: number
  highCount: number
  stories: InboxStoryGroup[]
}

/** 无法归属到任何工作区的事项统一落到这个兜底分组 */
const unassignedWorkspaceName = '未关联工作区'

/**
 * 取工作区分组键：从工作区相对路径中取出第一段目录名。
 * 后端上报的路径既可能是 `feature-x`，也可能是 `feature-x\repo-a`（Windows 分隔符），
 * 所以统一换成 `/` 再切分；路径为空时返回兜底名称，保证事项不会丢。
 * @param workspacePath 相对工作区根目录的路径，可能为空
 * @returns 工作区分组键
 */
function workspaceKeyOf(workspacePath: string | undefined): string {
  const normalized = (workspacePath ?? '').replaceAll('\\', '/').replace(/^\/+/, '')
  const [head] = normalized.split('/')
  return head || unassignedWorkspaceName
}

/**
 * 收件箱分组：工作区 → Story → 待决策事项。
 * 排序规则：普通工作区按名称升序、兜底分组置底；组内 Story 按高优先级数量降序，
 * 让「最该先处理」的 Story 排在工作区最前面。
 * @returns 分组后的收件箱数据，直接供模板渲染
 */
const inboxGroups = computed<InboxWorkspaceGroup[]>(() => {
  const titles = new Map((store.snapshot?.requirements ?? []).map((requirement) => [requirement.storyId, requirement.title]))
  const workspaces = new Map<string, InboxWorkspaceGroup>()
  const stories = new Map<string, InboxStoryGroup>()

  for (const item of inbox.value) {
    const key = workspaceKeyOf(item.workspacePath)
    let workspace = workspaces.get(key)
    if (!workspace) {
      workspace = { key, name: key, pathHint: '', itemCount: 0, highCount: 0, stories: [] }
      workspaces.set(key, workspace)
    }
    // 同一工作区可能跨多个仓库 worktree，只保留第一条更具体的路径作为提示
    if (!workspace.pathHint && item.workspacePath && item.workspacePath !== key) {
      workspace.pathHint = item.workspacePath
    }

    const storyKey = `${key}:${item.requirementId ?? ''}`
    let story = stories.get(storyKey)
    if (!story) {
      const storyId = item.requirementId ?? ''
      story = {
        key: storyKey,
        storyId: storyId || '未归属 Story',
        title: titles.get(storyId) ?? (storyId || '未归属 Story'),
        items: [],
        highCount: 0,
      }
      stories.set(storyKey, story)
      workspace.stories.push(story)
    }

    story.items.push(item)
    workspace.itemCount += 1
    if (item.priority === 'high') {
      story.highCount += 1
      workspace.highCount += 1
    }
  }

  const groups = [...workspaces.values()]
  for (const group of groups) {
    group.stories.sort((left, right) => right.highCount - left.highCount || left.title.localeCompare(right.title, 'zh-Hans-CN'))
  }
  return groups.sort((left, right) => {
    const leftUnassigned = left.name === unassignedWorkspaceName
    const rightUnassigned = right.name === unassignedWorkspaceName
    if (leftUnassigned !== rightUnassigned) return leftUnassigned ? 1 : -1
    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
})
const crons = computed(() => store.snapshot?.crons ?? [])
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
const builds = computed(() => store.snapshot?.builds ?? [])
const branches = computed(() => store.snapshot?.branches ?? [])
const mergeRequests = computed(() => store.snapshot?.mergeRequests ?? [])
const channels = computed(() => Object.entries(store.snapshot?.channels ?? {}))

/* ------------------------- 发布页：只显示本人的记录 ------------------------- */

/** 当前查看者身份；快照未识别出身份时缺省 */
const viewer = computed(() => store.snapshot?.viewer)

/** 发布页展示的合并请求：只保留本人创建的 MR，识别不到身份时退回全量 */
const myMergeRequests = computed(() => filterOwnMergeRequests(mergeRequests.value, viewer.value))

/** 发布页展示的构建记录：只保留本人触发的构建，识别不到身份时退回全量 */
const myBuilds = computed(() => filterOwnBuilds(builds.value, viewer.value))

/**
 * 取某个 Story 关联的实例列表：快照聚合的实例与本地新拉的实例合并后按 storyId 过滤。
 * @param storyId Harness Story ID
 * @returns 该 Story 下的实例数组
 */
function jobsByStory(storyId: string): Job[] {
  return jobs.value.filter((job) => job.storyId === storyId)
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
    stories: pipeline.story && pipeline.story.crons.length
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

/** 定时页是否一条任务都没有（用于空态提示） */
const cronGroupsEmpty = computed(() => crons.value.length === 0)
const pageHeading = computed(() => page.value === 'tools' ? '连接与配置' : String(route.meta.title ?? 'DevTask'))

watch([page, () => store.snapshot?.requirements.length], ([value]) => {
  if (value === 'workspaces') {
    void refreshRepositoryCandidates()
    void refreshWorkspaces()
  }
  if (value === 'instances') void refreshStoryServices()
  // 看板以 TAPD 需求为数据元，与其他页面的本地快照分开拉取
  if (value === 'board') void board.load()
}, { immediate: true })

// 刷新页面或直接进入深链接时，确保快照至少拉取一次，避免首屏空数据
onMounted(() => {
  void store.ensureLoaded()
})

watch(crons, (rows) => {
  for (const cron of rows) {
    if (cronMappingDrafts.value[cron.id]) continue
    cronMappingDrafts.value[cron.id] = {
      storyId: cron.storyId ?? '',
      ownerSessionId: cron.ownerSessionId ?? '',
      mode: cron.mode ?? '',
      saving: false,
      error: '',
    }
  }
}, { immediate: true })

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
  if (workspacePollTimer) clearTimeout(workspacePollTimer)
  jobStreamController?.abort()
})

function openRequirement(requirement: Requirement): void {
  selectedRequirement.value = requirement
}

async function openMergeRequest(mergeRequest: MergeRequest): Promise<void> {
  mergeRequestLoading.value = true
  mergeRequestError.value = ''
  try {
    const details = mergeRequestDetailsSchema.parse(await apiRequest<unknown>(
      `/api/v1/gitlab/projects/${mergeRequest.projectId}/merge-requests/${encodeURIComponent(mergeRequest.id)}`,
    ))
    selectedMergeRequest.value = mergeRequestSchema.parse({ ...mergeRequest, ...details })
  } catch (cause) {
    mergeRequestError.value = cause instanceof Error ? cause.message : 'Unable to load merge request details.'
  } finally {
    mergeRequestLoading.value = false
  }
}

async function saveCronMapping(taskId: string): Promise<void> {
  const draft = cronMappingDrafts.value[taskId]
  if (!draft || !draft.storyId || !draft.ownerSessionId.trim() || !draft.mode) return
  draft.saving = true
  draft.error = ''
  try {
    await apiRequest(`/api/v1/crons/${encodeURIComponent(taskId)}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({
        storyId: draft.storyId,
        ownerSessionId: draft.ownerSessionId.trim(),
        mode: draft.mode,
      }),
    })
    await store.refresh()
  } catch (cause) {
    draft.error = cause instanceof Error ? cause.message : 'Unable to save the task owner mapping.'
  } finally {
    draft.saving = false
  }
}

async function startStoryService(requirement: Requirement): Promise<void> {
  if (!requirement.workspacePath || startingStoryService.value) return
  startingStoryService.value = requirement.storyId
  storyServiceError.value = ''
  try {
    const service = await apiRequest<{ storyId: string; status: string; updatedAt: string; error?: string }>(
      `/api/v1/stories/${encodeURIComponent(requirement.storyId)}/service`,
      { method: 'POST' },
    )
    storyServices.value = { ...storyServices.value, [service.storyId]: service }
    await refreshStoryServices()
  } catch (cause) {
    storyServiceError.value = cause instanceof Error ? cause.message : 'Unable to start the Story service.'
  } finally {
    startingStoryService.value = null
  }
}

async function refreshStoryServices(): Promise<void> {
  storyServiceError.value = ''
  try {
    const services = await apiRequest<Array<{
      storyId: string
      status: string
      updatedAt: string
      error?: string
    }>>('/api/v1/stories/services')
    storyServices.value = Object.fromEntries(services.map((service) => [service.storyId, service]))
    const activeRequirements = storyServiceRequirements.value.filter(
      (requirement) => storyServices.value[requirement.storyId]?.status === 'running',
    )
    const jobLists = await Promise.all(activeRequirements.map(async (requirement) => {
      try {
        return await apiRequest<Job[]>(`/api/v1/stories/${encodeURIComponent(requirement.storyId)}/jobs`)
      } catch (cause) {
        storyServices.value = {
          ...storyServices.value,
          [requirement.storyId]: {
            ...storyServices.value[requirement.storyId],
            status: 'failed',
            error: cause instanceof Error ? cause.message : 'Unable to list Story jobs.',
          },
        }
        return []
      }
    }))
    storyJobs.value = jobLists.flat()
  } catch (cause) {
    storyServiceError.value = cause instanceof Error ? cause.message : 'Unable to read Story service status.'
  }
}

function prepareJob(requirement: Requirement, mode: 'run' | 'fixbugs'): void {
  selectedStoryId.value = requirement.storyId
  resumableSessions.value = []
  selectedResumableSession.value = ''
  jobName.value = `${requirement.title} · ${mode === 'run' ? '需求开发' : 'Bug 修复'}`
  jobPrompt.value = mode === 'run' ? `/start ${requirement.storyId}` : `/start fixbugs ${requirement.storyId}`
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

async function createJob(): Promise<void> {
  if (!selectedStoryId.value || !jobName.value.trim() || !jobPrompt.value.trim()) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    await apiRequest<unknown>(`/api/v1/stories/${encodeURIComponent(selectedStoryId.value)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ name: jobName.value.trim(), prompt: jobPrompt.value.trim() }),
    })
    selectedJob.value = null
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

async function replyToJob(): Promise<void> {
  if (!selectedJob.value?.storyId || !jobReply.value.trim()) return
  const job = selectedJob.value
  const storyId = job.storyId
  if (!storyId) return
  jobActionLoading.value = true
  jobError.value = ''
  try {
    await apiRequest(`/api/v1/stories/${encodeURIComponent(storyId)}/jobs/${encodeURIComponent(job.id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text: jobReply.value.trim(), bash: false }),
    })
    jobTranscript.value += `\n\nYou: ${jobReply.value.trim()}`
    jobReply.value = ''
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : 'Unable to send a reply.'
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

async function controlJob(action: 'stop' | 'respawn' | 'delete'): Promise<void> {
  const job = selectedJob.value
  if (!job?.storyId) return
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
      jobStreamController?.abort()
      selectedJob.value = null
    } else {
      jobStreamController?.abort()
    }
    await refreshStoryServices()
    if (action === 'respawn' && selectedJob.value?.id === job.id) void openJob(job)
  } catch (cause) {
    jobError.value = cause instanceof Error ? cause.message : `Unable to ${action} the Job.`
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

async function loadApplicationMappings(): Promise<void> {
  mappingsError.value = ''
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(
      await apiRequest<unknown>('/api/v1/application-mappings'),
    )
    const savedByRepo = new Map(applicationMappings.value.map((mapping) => [mapping.repoName, mapping]))
    mappingDrafts.value = Object.fromEntries(repositoryCandidates.value.map((candidate) => {
      const saved = savedByRepo.get(candidate.name)
      return [candidate.name, {
        gitlabProjectId: saved?.gitlabProjectId,
        // 差异映射才预填；否则留空表示沿用同名默认
        devopsApp: saved?.devopsApp ?? '',
        devopsGroup: saved?.devopsGroup ?? defaultDevOpsGroup,
        projects: [],
        loadingProjects: false,
        saving: false,
        saved: saved !== undefined,
        error: '',
      }]
    }))
  } catch (cause) {
    mappingsError.value = cause instanceof Error ? cause.message : 'Unable to load application mappings.'
  }
}

async function searchGitLabProjects(repoName: string): Promise<void> {
  const draft = mappingDrafts.value[repoName]
  if (!draft) return
  draft.loadingProjects = true
  draft.error = ''
  try {
    const query = new URLSearchParams({ search: repoName })
    const result: unknown = await apiRequest(`/api/v1/gitlab/projects?${query}`)
    draft.projects = gitLabProjectSchema.array().parse(result)
  } catch (cause) {
    draft.error = cause instanceof Error ? cause.message : 'GitLab project search failed.'
  } finally {
    draft.loadingProjects = false
  }
}

/**
 * 保存仓库的差异映射。
 * 应用名留空表示沿用“仓库名 == DevOps 应用名”，此时服务端不会写入记录。
 * @param repoName git 仓库名
 * @returns Promise<void>，错误写入行内 draft.error
 */
async function saveApplicationMapping(repoName: string): Promise<void> {
  const draft = mappingDrafts.value[repoName]
  if (!draft) return
  draft.error = ''
  const input = {
    repoName,
    devopsApp: draft.devopsApp.trim() || repoName,
    devopsGroup: draft.devopsGroup.trim() || defaultDevOpsGroup,
    ...(draft.gitlabProjectId ? { gitlabProjectId: draft.gitlabProjectId } : {}),
  }
  const parsed = applicationMappingSchema.safeParse(input)
  if (!parsed.success) {
    draft.error = parsed.error.issues.map((issue) => issue.message).join(' ')
    return
  }
  draft.saving = true
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(await apiRequest<unknown>(
      '/api/v1/application-mappings',
      { method: 'PUT', body: JSON.stringify(parsed.data) },
    ))
    draft.saved = applicationMappings.value.some((mapping) => mapping.repoName === repoName)
    if (!draft.saved) {
      // 与默认同名约定一致，服务端已清除差异映射
      draft.devopsApp = ''
      draft.devopsGroup = defaultDevOpsGroup
    }
  } catch (cause) {
    draft.error = cause instanceof Error ? cause.message : 'Unable to save application mapping.'
  } finally {
    draft.saving = false
  }
}

/**
 * 删除仓库的差异映射，回到“同名默认”约定。
 * @param repoName git 仓库名
 * @returns Promise<void>
 */
async function resetApplicationMapping(repoName: string): Promise<void> {
  const draft = mappingDrafts.value[repoName]
  if (!draft) return
  draft.error = ''
  draft.saving = true
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(await apiRequest<unknown>(
      `/api/v1/application-mappings/${encodeURIComponent(repoName)}`,
      { method: 'DELETE' },
    ))
    draft.gitlabProjectId = undefined
    draft.devopsApp = ''
    draft.devopsGroup = defaultDevOpsGroup
    draft.saved = false
  } catch (cause) {
    draft.error = cause instanceof Error ? cause.message : 'Unable to remove application mapping.'
  } finally {
    draft.saving = false
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
  try {
    workspaceJob.value = workspaceInitializationJobSchema.parse(await apiRequest<unknown>('/api/v1/workspaces/initialize', {
      method: 'POST',
      body: JSON.stringify(workspaceRequest()),
    }))
    pollWorkspaceJob(workspaceJob.value.id)
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : 'Unable to start workspace initialization.'
  }
}

function pollWorkspaceJob(jobId: string): void {
  if (workspacePollTimer) clearTimeout(workspacePollTimer)
  workspacePollTimer = setTimeout(async () => {
    try {
      workspaceJob.value = workspaceInitializationJobSchema.parse(
        await apiRequest<unknown>(`/api/v1/workspaces/initialize/${jobId}`),
      )
      if (workspaceJob.value.status === 'running') pollWorkspaceJob(jobId)
      else if (workspaceJob.value.status === 'succeeded') {
        await Promise.all([store.refresh(), refreshWorkspaces()])
      }
    } catch (cause) {
      workspaceError.value = cause instanceof Error ? cause.message : 'Unable to read initialization progress.'
    }
  }, 1000)
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
}

/** 重置新建表单并打开新建弹窗。 */
function openCreateDialog(): void {
  workspaceName.value = ''
  branch.value = ''
  baseBranch.value = ''
  selectedRepositoryNames.value = []
  skipInstall.value = false
  skipGraphify.value = false
  previewResult.value = null
  workspaceJob.value = null
  workspaceError.value = ''
  createDialogOpen.value = true
}

/** 关闭新建弹窗；初始化任务运行中时禁止关闭，避免丢失进度。 */
function closeCreateDialog(): void {
  if (workspaceRunning.value) return
  createDialogOpen.value = false
}

/**
 * el-dialog 关闭前的守卫：初始化任务运行中不允许关闭。
 * @param done 允许关闭时调用的回调
 */
function beforeCreateDialogClose(done: () => void): void {
  if (!workspaceRunning.value) done()
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

/**
 * 格式化时间为本地可读文本。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无值时返回 '未知'
 */
function formatWorkspaceTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '未知'
}
</script>

<template>
  <section class="page-content">
    <div class="page-heading-row">
      <div>
        <p class="eyebrow">DEV TASK CONSOLE</p>
        <h1>{{ pageHeading }}</h1>
        <p class="page-subtitle">{{ page === 'inbox' ? '先处理真正需要你决策的事项。' : '状态来自各自系统；控制台只聚合展示与提供安全入口。' }}</p>
      </div>
      <div class="heading-actions">
        <span v-if="store.snapshot" class="freshness">快照 {{ new Date(store.snapshot.snapshotAt).toLocaleTimeString() }}</span>
        <el-button :loading="store.loading" @click="store.refresh()">刷新</el-button>
      </div>
    </div>

    <div v-if="store.error" class="notice notice-warning" role="status">
      <span class="notice-symbol">!</span>
      <div><strong>数据暂不可用</strong><p>{{ store.error }}</p></div>
      <el-button text @click="store.refresh()">重试</el-button>
    </div>

    <template v-if="page === 'inbox'">
      <div class="stat-grid">
        <article class="stat-card"><span>待决策</span><strong>{{ inbox.length }}</strong><small>需要人工处理</small></article>
        <article class="stat-card"><span>高优先级</span><strong>{{ inbox.filter((item) => item.priority === 'high').length }}</strong><small>先处理风险项</small></article>
        <article class="stat-card"><span>运行中实例</span><strong>{{ jobs.filter((job) => job.status === 'busy').length }}</strong><small>CodeBuddy jobs</small></article>
        <article class="stat-card"><span>今日已处理</span><strong>—</strong><small>审计能力接入后统计</small></article>
      </div>
      <section class="surface">
        <div class="section-heading"><div><h2>待你处理</h2><p>只显示阻塞流程或需要判断的事项</p></div><span class="count-pill">{{ inbox.length }} 项</span></div>
        <div v-if="inboxGroups.length" class="inbox-groups">
          <section v-for="group in inboxGroups" :key="group.key" class="inbox-workspace">
            <header class="inbox-workspace-head">
              <span class="inbox-workspace-name">
                <strong>{{ group.name }}</strong>
                <code v-if="group.pathHint">{{ group.pathHint }}</code>
              </span>
              <span class="count-pill">{{ group.itemCount }} 项 · 高优先级 {{ group.highCount }}</span>
            </header>
            <div v-for="story in group.stories" :key="story.key" class="inbox-story">
              <div class="inbox-story-head">
                <strong>{{ story.title }}</strong>
                <code>{{ story.storyId }}</code>
                <span v-if="story.highCount" class="tag tag-danger">高优先级 {{ story.highCount }}</span>
              </div>
              <div class="inbox-list">
                <article v-for="item in story.items" :key="item.id" class="inbox-row">
                  <span class="priority-marker" :class="item.priority">{{ item.priority === 'high' ? '!' : '·' }}</span>
                  <div class="inbox-copy"><div class="inbox-title-line"><strong>{{ item.title }}</strong><span class="kind-label">{{ item.kind.replaceAll('_', ' ') }}</span></div><p>{{ item.reason }}</p></div>
                  <el-button type="primary" plain size="small" :disabled="!item.target" @click="item.target && $router.push(item.target)">查看处理</el-button>
                </article>
              </div>
            </div>
          </section>
        </div>
        <div v-else-if="!store.loaded" class="empty-compact">正在加载快照…</div>
        <div v-else class="empty-state"><span class="empty-icon">✓</span><strong>{{ store.error ? '连接数据源后显示待决策事项' : '现在没有需要你决策的事' }}</strong><p>{{ store.error ? '请先完成连接自检，或检查后端数据聚合器。' : '新出现的阻塞项、待确认项和失败构建会集中显示在这里。' }}</p></div>
      </section>
    </template>

    <template v-else-if="page === 'board'">
      <section class="surface">
        <div class="section-heading">
          <div><h2>需求总览</h2><p>数据元以 TAPD 需求为准；每个需求可关联一个本地工作区</p></div>
          <div class="board-controls">
            <el-input v-model="board.owner" class="inline-search" placeholder="TAPD 处理人" clearable @keyup.enter="board.load()" />
            <el-select
              :model-value="board.includeReleased"
              class="board-filter"
              placeholder="状态筛选"
              @change="board.setIncludeReleased"
            >
              <el-option label="排除已发布（默认）" :value="false" />
              <el-option label="包含已发布" :value="true" />
            </el-select>
            <el-button :loading="board.loading" @click="board.load()">刷新</el-button>
            <el-button type="primary" @click="board.openManual()">手动添加</el-button>
          </div>
        </div>
        <p class="board-meta">
          <span>处理人 {{ board.owner }}</span>
          <span v-if="board.fetchedAt">TAPD 拉取于 {{ new Date(board.fetchedAt).toLocaleString() }}</span>
          <span class="tag" :class="board.channelOk ? 'tag-success' : 'tag-warning'">{{ board.channelOk ? 'TAPD 已连接' : 'TAPD 不可用' }}</span>
          <span>{{ board.stories.length }} 个需求</span>
          <span v-if="!board.includeReleased && board.hiddenReleased">
            已隐藏 {{ board.hiddenReleased }} 条已发布需求，
            <el-button link type="primary" size="small" @click="board.setIncludeReleased(true)">查看</el-button>
          </span>
        </p>
        <p v-if="board.error" class="mapping-error" role="alert">{{ board.error }}</p>
        <div v-if="board.stories.length" class="board-list">
          <article v-for="story in board.stories" :key="story.storyId" class="board-row">
            <div class="board-main">
              <a :href="story.tapdUrl" target="_blank" rel="noreferrer">{{ story.title }}</a>
              <small>
                <code>{{ story.storyId }}</code>
                <span v-if="story.statusLabel || story.status" :title="story.status">状态 {{ story.statusLabel ?? story.status }}</span>
                <span v-if="story.iterationName">{{ story.iterationName }}</span>
                <span v-if="story.owner">{{ story.owner }}</span>
              </small>
            </div>
            <div class="board-workspace">
              <el-select v-model="board.workspaceDraft[story.storyId]" clearable filterable placeholder="选择本地工作区" @change="board.bindSelected(story)">
                <el-option v-for="workspace in board.workspaceOptionsFor(story)" :key="workspace.name" :label="workspace.name" :value="workspace.name" />
              </el-select>
              <code v-if="story.workspacePath">{{ story.workspacePath }}</code>
              <small v-else-if="story.workspaceName" class="mapping-error">目录未找到：{{ story.workspaceName }}</small>
              <small v-else class="muted">未关联本地工作区</small>
              <small v-if="!story.inTapdList" class="tag tag-warning">本地手动添加</small>
            </div>
            <div class="board-actions">
              <el-button size="small" :loading="board.unbindingStoryId === story.storyId" :disabled="!story.workspaceName" @click="board.unbindWorkspace(story.storyId)">解绑</el-button>
            </div>
            <p v-if="board.rowErrors[story.storyId]" class="mapping-error" role="alert">{{ board.rowErrors[story.storyId] }}</p>
          </article>
        </div>
        <div v-else-if="board.loading" class="empty-compact">正在查询 TAPD 需求…</div>
        <div v-else class="empty-state">
          <strong>暂无需求数据</strong>
          <p>确认 TAPD 连接正常，并检查处理人是否为 TAPD 中的姓名；也可用「手动添加」直接绑定需求链接。</p>
        </div>
      </section>

      <el-dialog v-model="board.manualOpen" title="手动添加需求" width="min(560px, 94vw)" :close-on-click-modal="false" @close="board.closeManual()">
        <div class="board-manual-form">
          <label>TAPD 需求链接或 ID<el-input v-model="board.manualDraft.tapdStoryId" placeholder="https://www.tapd.cn/.../view/1138... 或纯数字 ID" /></label>
          <label>需求名称（可选，TAPD 查询不到时展示）<el-input v-model="board.manualDraft.storyTitle" /></label>
          <label>关联本地工作区<el-select v-model="board.manualDraft.workspaceName" filterable placeholder="选择 *.code-workspace 识别出的工作区">
            <el-option v-for="workspace in board.workspaces" :key="workspace.name" :label="workspace.name" :value="workspace.name" />
          </el-select></label>
        </div>
        <p v-if="board.manualError" class="mapping-error" role="alert">{{ board.manualError }}</p>
        <template #footer>
          <el-button @click="board.closeManual()">取消</el-button>
          <el-button type="primary" :loading="board.manualSaving" @click="board.submitManual()">保存绑定</el-button>
        </template>
      </el-dialog>
    </template>

    <template v-else-if="page === 'pipeline'">
      <section class="surface">
        <div class="section-heading"><div><h2>端到端链路</h2><p>一个工作区一条流水线：Story 只从第一个项目的 .codebuddy/plans 识别</p></div><span class="count-pill">{{ workspacePipelines.length }} 个工作区 · {{ pipelineStoryCount }} 个 Story</span></div>
        <div v-for="workflow in activeWorkflows" :key="`${workflow.workspacePath}:${workflow.storyId}`" class="notice notice-warning">
          <span class="notice-symbol">!</span>
          <div><strong>Harness 活跃流程：{{ workflow.title }}</strong><p>{{ workflow.storyId }} · {{ workflow.mode || '模式未知' }} · Phase {{ workflow.phase ?? '未知' }} · {{ workflow.status || '状态未知' }} · {{ workflow.workspacePath }}</p></div>
        </div>

        <div v-for="pipeline in workspacePipelines" :key="`pipeline:${pipeline.path}`" class="workspace-block">
          <div class="workspace-block-head">
            <div class="workspace-main"><strong>{{ pipeline.name }}</strong><small><code>{{ pipeline.path }}</code></small></div>
            <span v-if="pipeline.missingProjects.length" class="tag tag-danger">{{ pipeline.missingProjects.length }} 个目录缺失</span>
            <span v-if="pipeline.storyCandidates > 1" class="tag tag-warning">检测到 {{ pipeline.storyCandidates }} 份 Story，仅展示 1 份</span>
          </div>

          <article class="project-block">
            <div class="project-head">
              <strong v-if="pipeline.primaryProject">{{ pipeline.primaryProject.name }}</strong>
              <strong v-else>未声明项目</strong>
              <code v-if="pipeline.primaryProject?.branch">{{ pipeline.primaryProject?.branch }}</code>
              <span v-if="pipeline.primaryProject" class="tag" :class="pipeline.primaryProject.worktree ? 'tag-success' : ''">{{ pipeline.primaryProject.worktree ? 'worktree' : '独立克隆' }}</span>
              <small class="muted">{{ pipeline.mergeRequests.length }} 个 MR · {{ pipeline.builds.length }} 条构建 · {{ pipeline.crons.length }} 个定时</small>
            </div>
            <div v-if="!pipeline.story" class="project-empty">第一个项目里还没有 .codebuddy/plans 中的 Story。</div>
            <article v-else class="pipeline-row" @click="openRequirement(pipeline.story.requirement)">
              <div class="pipeline-title"><strong>{{ pipeline.story?.requirement.title }}</strong><code>{{ pipeline.story?.requirement.storyId }}</code></div>
              <div class="pipeline-steps">
                <span>Harness {{ pipeline.story?.requirement.phase === undefined ? '—' : `P${pipeline.story?.requirement.phase}` }}</span><i>→</i>
                <span :class="{ 'pipeline-step-active': pipeline.story?.mergeRequests.length }">MR {{ pipeline.story?.mergeRequests.length }}</span><i>→</i>
                <span :class="{ 'pipeline-step-active': pipeline.builds.length }">构建 {{ pipeline.builds.length }}</span><i>→</i>
                <span :class="{ 'pipeline-step-active': pipeline.story?.crons.length }">定时 {{ pipeline.story?.crons.length }}</span>
              </div>
              <span v-if="pipeline.story?.harnessActive" class="tag tag-warning">流程活跃</span>
              <el-icon class="row-arrow"><Files /></el-icon>
            </article>
          </article>
        </div>

        <div v-if="!workspacePipelines.length && !snapshotLoaded" class="empty-compact">正在加载快照…</div>
        <div v-else-if="!workspacePipelines.length" class="empty-state"><strong>还没有工作区</strong><p>先在「工作区」页新建工作区；Story 需要放在第一个项目的 .codebuddy/plans 下。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'instances'">
      <div class="split-layout">
        <section class="surface split-list">
          <div class="section-heading"><div><h2>CodeBuddy 实例</h2><p>以工作区为根：工作区 → 第一个项目 → Story 实例；服务与执行轮次分开管理</p></div><span class="count-pill">{{ jobs.length }}</span></div>
          <div v-for="group in instanceGroups" :key="group.key" class="workspace-block">
            <div class="workspace-block-head">
              <div class="workspace-main"><strong>{{ group.name }}</strong><small><code>{{ group.path }}</code></small></div>
            </div>
            <article class="project-block">
              <div class="project-head">
                <strong>{{ group.project?.name ?? '未声明项目' }}</strong>
                <code v-if="group.project?.branch">{{ group.project?.branch }}</code>
                <small class="muted">{{ group.stories.length }} 个 Story</small>
              </div>
              <div v-if="!group.stories.length" class="project-empty">第一个项目还没有 Story，无需启动实例。</div>
              <template v-for="requirement in group.stories" :key="requirement.storyId">
                <div class="simple-list-row">
                  <span class="status-dot" :class="storyServices[requirement.storyId]?.status === 'running' ? 'is-active' : ''" />
                  <span><strong>{{ requirement.title }}</strong><small>{{ requirement.storyId }} · {{ requirement.workspacePath }}</small></span>
                  <span v-if="storyServices[requirement.storyId]" class="tag" :class="storyServices[requirement.storyId].status === 'running' ? 'tag-success' : 'tag-danger'">{{ storyServices[requirement.storyId].status }}</span>
                  <template v-if="storyServices[requirement.storyId]?.status === 'running'">
                    <el-button size="small" @click="prepareJob(requirement, 'run')">需求开发</el-button>
                    <el-button size="small" type="warning" @click="prepareJob(requirement, 'fixbugs')">Bug 修复</el-button>
                    <el-button size="small" @click="loadResumableSessions(requirement)">加载可恢复会话</el-button>
                  </template>
                  <el-button v-else size="small" type="primary" :loading="startingStoryService === requirement.storyId" :disabled="startingStoryService !== null" @click="startStoryService(requirement)">启动 / 接管</el-button>
                </div>
                <small v-if="storyServices[requirement.storyId]?.error" class="mapping-error">{{ storyServices[requirement.storyId].error }}</small>
                <button v-for="job in jobsByStory(requirement.storyId)" :key="job.id" class="simple-list-row instance-job-row" :class="{ 'is-selected': selectedJob?.id === job.id }" type="button" @click="openJob(job)"><span class="status-dot" :class="job.status === 'busy' ? 'is-active' : ''" /><span><strong>{{ job.name }}</strong><small>{{ job.id }} · {{ job.cwd }}</small></span><code>{{ job.state }}</code></button>
              </template>
            </article>
          </div>
          <div v-if="!instanceGroups.length && !snapshotLoaded" class="empty-compact">正在加载快照…</div>
          <div v-else-if="!instanceGroups.length" class="empty-state"><strong>还没有工作区</strong><p>先在「工作区」页新建工作区，项目下的 Story 才能启动实例。</p></div>
          <p v-if="storyServiceError" class="mapping-error" role="alert">{{ storyServiceError }}</p>
        </section>
        <section class="surface instance-workspace">
          <template v-if="selectedStoryId && !selectedJob">
            <p class="eyebrow">NEW STORY ROUND</p><h2>创建实例</h2>
            <el-input v-model="jobName" class="job-input" placeholder="实例名称" />
            <el-input v-model="jobPrompt" type="textarea" :rows="5" placeholder="发送给 CodeBuddy 的提示词" />
            <el-button type="primary" :loading="jobActionLoading" :disabled="!jobPrompt.trim() || !jobName.trim()" @click="createJob">创建实例</el-button>
            <div class="job-rename"><el-select v-model="selectedResumableSession" :loading="resumableLoading" placeholder="选择可恢复会话">
              <el-option v-for="session in resumableSessions" :key="session.sessionId" :label="session.name || session.sessionId" :value="session.sessionId" />
            </el-select><el-button :loading="jobActionLoading" :disabled="!selectedResumableSession" @click="resumeSession">恢复</el-button></div>
          </template>
          <template v-else-if="selectedJob">
            <p class="eyebrow">SESSION OUTPUT · {{ selectedJob.storyId }}</p>
            <div class="section-heading"><div><h2>{{ selectedJob.name }}</h2><p>{{ selectedJob.state }} · {{ selectedJob.status }} · {{ selectedJob.sessionId || '无 session ID' }}</p></div>
              <div class="job-actions"><el-button size="small" :loading="jobActionLoading" @click="controlJob('stop')">暂停</el-button><el-button size="small" :loading="jobActionLoading" @click="controlJob('respawn')">重启</el-button><el-button size="small" type="danger" :loading="jobActionLoading" @click="controlJob('delete')">删除</el-button></div>
            </div>
            <div class="job-rename"><el-input v-model="renameDraft" size="small" placeholder="实例名称" /><el-button size="small" :loading="jobActionLoading" @click="renameJob">重命名</el-button></div>
            <pre class="job-transcript">{{ jobTranscript || '暂无历史对话' }}</pre>
            <pre class="job-output">{{ jobOutput || '等待实时输出…' }}</pre>
            <el-input v-model="jobReply" type="textarea" :rows="3" placeholder="回复实例（不执行 bash）" />
            <el-button type="primary" :loading="jobActionLoading" :disabled="!jobReply.trim()" @click="replyToJob">发送</el-button>
          </template>
          <template v-else>
            <p class="eyebrow">SESSION OUTPUT</p><h2>选择一个实例</h2><p class="muted">每个 Story 服务复用端口，每轮 run/fixbugs 是独立 Job/session；cron owner 与执行轮次分离。</p><div class="terminal-placeholder">等待实例选择<span>_</span></div>
          </template>
          <p v-if="jobError" class="mapping-error" role="alert">{{ jobError }}</p>
        </section>
      </div>
    </template>

    <template v-else-if="page === 'crons'">
      <section class="surface">
        <div class="section-heading"><div><h2>定时任务</h2><p>以工作区为根：工作区 → 第一个项目 → Story 定时任务；任务读自项目目录下的 .codebuddy/scheduled_tasks.json，这里只保存显式 Story、模式和 owner session 映射。</p></div><span class="count-pill">{{ crons.length }} 个</span></div>
        <div v-for="group in cronGroups" :key="group.key" class="workspace-block">
          <div class="workspace-block-head">
            <div class="workspace-main"><strong>{{ group.name }}</strong><small><code>{{ group.path }}</code></small></div>
          </div>
          <article class="project-block">
            <div class="project-head">
              <strong>{{ group.project?.name ?? '未声明项目' }}</strong>
              <code v-if="group.project?.branch">{{ group.project?.branch }}</code>
              <small class="muted">{{ group.stories.length }} 个 Story 有任务 · {{ group.looseCrons.length }} 个未关联任务</small>
            </div>
            <div v-if="!group.stories.length && !group.looseCrons.length" class="project-empty">第一个项目暂无定时任务。</div>
            <CronTaskRow v-for="cron in group.looseCrons" :key="`loose:${cron.id}`" :cron="cron" :draft="cronMappingDrafts[cron.id]" @save="saveCronMapping" />
            <template v-for="story in group.stories" :key="story.requirement.storyId">
              <div class="cron-story-head"><strong>{{ story.requirement.title }}</strong><code>{{ story.requirement.storyId }}</code></div>
              <CronTaskRow v-for="cron in story.crons" :key="cron.id" :cron="cron" :draft="cronMappingDrafts[cron.id]" @save="saveCronMapping" />
            </template>
          </article>
          <template v-if="group.unassignedCrons.length">
            <div class="cron-story-head"><strong>未归属任务</strong></div>
            <CronTaskRow v-for="cron in group.unassignedCrons" :key="cron.id" :cron="cron" :draft="cronMappingDrafts[cron.id]" @save="saveCronMapping" />
          </template>
        </div>
        <div v-if="cronGroupsEmpty" class="empty-state"><strong>暂无定时任务</strong><p>检查需求工作区中的 .codebuddy/scheduled_tasks.json。修改、暂停与删除保持禁用，直到 CodeBuddy scheduled-task API 语义经过验证。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'releases'">
      <div class="notice notice-danger"><span class="notice-symbol">!</span><div><strong>发布写操作暂不可用</strong><p>R16 部署数据口径和 R17 dev/test 关系尚待确认；自动化和手动写操作在确认前必须保持禁用。</p></div></div>
      <section class="surface"><div class="section-heading"><div><h2>构建与合并记录</h2><p>只读展示本人的 GitLab MR 与 DevOps 构建；分支为项目级事实</p></div></div>
        <div v-for="mr in myMergeRequests" :key="`${mr.projectId}:${mr.id}`" class="release-row"><span class="tag">{{ mr.state }}</span><strong>{{ mr.title }}</strong><code>{{ mr.sourceBranch }} → {{ mr.targetBranch }}</code><span v-if="mr.mergeStatus">合并状态：{{ mr.mergeStatus }}</span><span v-if="mr.mergedAt">合并于 {{ new Date(mr.mergedAt).toLocaleString() }}</span><a v-if="mr.webUrl" :href="mr.webUrl" target="_blank" rel="noreferrer">打开 MR</a><el-button size="small" :loading="mergeRequestLoading" @click="openMergeRequest(mr)">详情</el-button></div>
        <p v-if="mergeRequestError" class="mapping-error" role="alert">{{ mergeRequestError }}</p>
        <div v-for="branchRecord in branches" :key="`${branchRecord.group}:${branchRecord.app}:${branchRecord.name}`" class="release-row"><span class="tag">{{ branchRecord.group || '分支' }}</span><strong>{{ branchRecord.app }}</strong><code>{{ branchRecord.name }} · {{ branchRecord.commitId || 'commit 未知' }}</code><span>{{ branchRecord.lastCommitTime ? new Date(branchRecord.lastCommitTime).toLocaleString() : '最后提交时间未知' }}</span></div>
        <div v-for="build in myBuilds" :key="build.id" class="release-row"><span class="tag" :class="build.succeed === false ? 'tag-danger' : 'tag-success'">{{ build.succeed === null ? '运行中' : build.succeed ? '成功' : '失败' }}</span><strong>{{ build.app }}<small v-if="build.group"> · {{ build.group }}</small></strong><code>{{ build.number ? `#${build.number} · ` : '' }}{{ build.branch || '分支未知' }} · {{ build.commitId || 'commit 未知' }}</code><span>{{ build.buildDate ? new Date(build.buildDate).toLocaleString() : '时间未知' }}</span><span v-if="build.durationTime !== undefined || build.operator">{{ build.durationTime !== undefined ? `${build.durationTime}s` : '' }}{{ build.durationTime !== undefined && build.operator ? ' · ' : '' }}{{ build.operator || '' }}</span><a v-if="build.fileUrl" :href="build.fileUrl" target="_blank" rel="noreferrer">制品</a></div>
        <div v-if="!myMergeRequests.length && !branches.length && !myBuilds.length" class="empty-state"><strong>暂无本人发布记录</strong><p>GitLab 与 DevOps 连接后显示本人创建的 MR、本人触发的构建与项目分支。当前页面不会触发外部写操作。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'workspaces'">
      <section class="surface">
        <div class="section-heading">
          <div><h2>工作区列表</h2><p>工作区来自工作区根目录；可查看每个工作区包含的项目，或删除工作区</p></div>
          <div class="workspace-actions">
            <el-button :loading="workspacesLoading" @click="refreshWorkspaces()">刷新</el-button>
            <el-button type="primary" @click="openCreateDialog">新建工作区</el-button>
          </div>
        </div>
        <p v-if="workspacesError" class="mapping-error" role="alert">{{ workspacesError }}</p>
        <div v-if="workspaces.length" class="workspace-list">
          <article v-for="workspace in workspaces" :key="workspace.name" class="workspace-row">
            <div class="workspace-main">
              <strong>{{ workspace.name }}</strong>
              <small><code>{{ workspace.path }}</code></small>
            </div>
            <span class="count-pill">{{ workspace.projects.length }} 个项目</span>
            <span v-if="!workspace.workspaceFile" class="tag tag-warning">缺少 .code-workspace</span>
            <span v-if="workspace.missingProjects.length" class="tag tag-danger">{{ workspace.missingProjects.length }} 个目录缺失</span>
            <span class="muted">{{ formatWorkspaceTime(workspace.updatedAt) }}</span>
            <div class="workspace-row-actions">
              <el-button size="small" @click="openWorkspaceDetail(workspace)">详情</el-button>
              <el-button size="small" type="danger" plain @click="openDeleteDialog(workspace)">删除</el-button>
            </div>
          </article>
        </div>
        <div v-else-if="workspacesLoading" class="empty-compact">正在加载工作区…</div>
        <div v-else class="empty-state"><strong>还没有工作区</strong><p>点击「新建工作区」，选择多个项目后会自动创建 git worktree 与 .code-workspace 文件。</p></div>
      </section>

      <section class="surface">
        <div class="section-heading"><div><h2>源系统映射</h2><p>默认 git 仓库名 = DevOps 应用名，同名无需映射；只保存名称不一致的人工确认结果，GitLab 搜索结果不会自动采用。</p></div><el-button :loading="candidatesLoading" @click="refreshRepositoryCandidates()">刷新映射</el-button></div>
        <div v-if="candidatesError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>无法扫描仓库</strong><p>{{ candidatesError }}</p></div></div>
        <p v-if="mappingsError" class="notice notice-warning">{{ mappingsError }}</p>
        <div v-for="candidate in repositoryCandidates" :key="`mapping:${candidate.name}`" class="mapping-card">
          <div class="mapping-card-head">
            <strong>{{ candidate.name }}</strong>
            <span class="tag" :class="mappingDrafts[candidate.name]?.saved ? 'tag-warning' : 'tag-success'">
              {{ mappingDrafts[candidate.name]?.saved ? '已保存差异映射' : '默认同名映射' }}
            </span>
          </div>
          <p class="mapping-hint">
            默认：GitLab 项目按「{{ candidate.name }}」精确匹配，DevOps 应用 = {{ candidate.name }}，分组 = {{ defaultDevOpsGroup }}。
            名称不一致时在下方人工填写并保存。
          </p>
          <div class="mapping-controls">
            <div class="mapping-control">
              <span>GitLab 项目（差异时人工选择）</span>
              <div class="mapping-inline">
                <el-button size="small" :loading="mappingDrafts[candidate.name]?.loadingProjects" @click="searchGitLabProjects(candidate.name)">搜索</el-button>
                <el-select v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].gitlabProjectId" clearable filterable placeholder="留空 = 按仓库名精确匹配">
                  <el-option v-for="project in mappingDrafts[candidate.name].projects" :key="project.id" :label="project.pathWithNamespace" :value="project.id" />
                </el-select>
              </div>
            </div>
            <label class="mapping-control"><span>DevOps 分组</span><el-input v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].devopsGroup" :placeholder="defaultDevOpsGroup" /></label>
            <label class="mapping-control"><span>DevOps 应用</span><el-input v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].devopsApp" :placeholder="`${candidate.name}（默认同名，留空即可）`" /></label>
            <el-button size="small" type="primary" :loading="mappingDrafts[candidate.name]?.saving" @click="saveApplicationMapping(candidate.name)">保存映射</el-button>
            <el-button size="small" :disabled="!mappingDrafts[candidate.name]?.saved" :loading="mappingDrafts[candidate.name]?.saving" @click="resetApplicationMapping(candidate.name)">恢复默认</el-button>
          </div>
          <small v-if="mappingDrafts[candidate.name]?.error" class="mapping-error">{{ mappingDrafts[candidate.name].error }}</small>
        </div>
        <div v-if="!candidatesLoading && !repositoryCandidates.length && !candidatesError" class="empty-state"><strong>未发现 Git 仓库</strong><p>检查源仓库根目录配置，或刷新扫描。</p></div>
      </section>
    </template>

    <template v-else>
      <div class="tool-grid">
        <section class="surface"><div class="section-heading"><div><h2>通道状态</h2><p>读取统一快照中的数据源健康状态</p></div><el-button :loading="snapshotLoading" @click="refreshSnapshot()">重新检测</el-button></div>
          <div v-for="[name, channel] in channels" :key="name" class="channel-row"><span class="status-dot" :class="channel.ok ? 'is-active' : 'is-error'" /><strong>{{ name }}</strong><span>{{ channel.error ? channel.error : channel.ok ? '连接正常' : '不可用' }}</span><small>{{ channel.fetchedAt ? new Date(channel.fetchedAt).toLocaleString() : '尚未检测' }}</small></div>
          <div v-if="!channels.length" class="empty-compact">聚合器配置完成后显示各通道检测结果。</div>
        </section>
        <section class="surface"><p class="eyebrow">LOCAL SECURITY</p><h2>本机信任边界</h2><p class="muted">控制台 API 由本地访问令牌保护。CodeBuddy 服务使用 <code>--auth none</code> 时，本机其他进程仍可能访问其高权限 API；Loopback 和请求标记不构成上游认证。</p></section>
      </div>
    </template>
  </section>

  <el-drawer
    v-model="detailOpen"
    title="需求详情"
    size="min(560px, 94vw)"
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    @close="selectedRequirement = null"
  >
    <template v-if="selectedRequirement">
      <p class="eyebrow">{{ selectedRequirement.storyId }}</p><h2>{{ selectedRequirement.title }}</h2>
      <div class="detail-grid"><span>阶段</span><strong>{{ selectedRequirement.phase === undefined ? '未知' : `Phase ${selectedRequirement.phase}` }}</strong><span>处理人</span><strong>{{ selectedRequirement.owner || '未分配' }}</strong><span>工作区</span><code>{{ selectedRequirement.workspacePath || '未关联' }}</code><span>Bug</span><strong>new {{ selectedRequirement.bugNew ?? 0 }} · reopened {{ selectedRequirement.bugReopened ?? 0 }}</strong></div>
      <section class="bug-detail-list">
        <h3>关联缺陷</h3>
        <article v-for="bug in selectedBugs" :key="bug.id" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ bug.title || `Bug ${bug.id}` }}</strong><span class="tag" :class="bug.status === 'reopened' ? 'tag-danger' : 'tag-warning'">{{ bug.status }}{{ bug.status === 'reopened' ? ' · 需读评论' : '' }}</span></div>
          <p>{{ bug.currentOwner }}<span v-if="bug.module"> · {{ bug.module }}</span><span v-if="bug.created"> · {{ bug.created }}</span></p>
          <p v-if="bug.description">{{ bug.description }}</p>
        </article>
        <p v-if="!selectedBugs.length" class="muted">{{ tapdAvailable ? '没有符合当前处理人口径的新建或重开缺陷。' : 'TAPD 数据不可用；请先检查连接状态。' }}</p>
      </section>
      <section v-if="selectedHarnessBugs.length" class="bug-detail-list">
        <h3>Harness 修复记录</h3>
        <article v-for="bug in selectedHarnessBugs" :key="bug.bugId" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ bug.title }}</strong><span class="tag" :class="bug.status === 'reopened' ? 'tag-danger' : ''">{{ bug.bugId }} · {{ bug.status }}{{ bug.category ? ` · ${bug.category}` : '' }}</span></div>
          <p v-if="bug.commentDigest">{{ bug.commentDigest }}</p>
          <p v-if="bug.writeback">回写 {{ bug.writeback.commentKind }} · {{ bug.writeback.commentedAt }}</p>
        </article>
      </section>
      <section v-if="selectedQuestions.length" class="bug-detail-list">
        <h3>需求待确认项</h3>
        <article v-for="question in selectedQuestions" :key="question.id" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ question.id }} · {{ question.question }}</strong><span class="tag" :class="question.state === 'pending_confirmation' || question.state === 'no_proposal' ? 'tag-warning' : ''">{{ question.state }}</span></div>
          <p v-if="question.resolution">建议稿：{{ question.resolution }}</p>
          <p v-if="question.state === 'pending_confirmation' || question.state === 'no_proposal'">本站只展示，不会代替用户写入确认或推进 Harness。</p>
        </article>
      </section>
      <p class="muted">此处只展示各数据源状态；流程推进与状态写入由对应源系统负责。</p>
    </template>
    <template #footer>
      <el-button @click="selectedRequirement = null">关闭</el-button>
    </template>
  </el-drawer>
  <el-drawer
    :model-value="selectedMergeRequest !== null"
    title="Merge Request 详情"
    size="min(560px, 94vw)"
    @close="selectedMergeRequest = null"
  >
    <template v-if="selectedMergeRequest">
      <p class="eyebrow">{{ selectedMergeRequest.sourceBranch }} → {{ selectedMergeRequest.targetBranch }}</p>
      <h2>{{ selectedMergeRequest.title }}</h2>
      <div class="detail-grid">
        <span>审批</span><strong>{{ selectedMergeRequest.approvals?.approved ? '已批准' : '未批准' }}</strong>
        <span>批准人</span><strong>{{ selectedMergeRequest.approvals?.approvedBy.join('、') || '无' }}</strong>
        <span>变更文件</span><strong>{{ selectedMergeRequest.changesCount ?? '未知' }}</strong>
      </div>
      <section class="bug-detail-list">
        <h3>文件列表</h3>
        <ul v-if="selectedMergeRequest.changedFiles?.length">
          <li v-for="file in selectedMergeRequest.changedFiles" :key="file"><code>{{ file }}</code></li>
        </ul>
        <p v-else class="muted">没有变更文件，或 GitLab 未返回文件列表。</p>
      </section>
    </template>
  </el-drawer>

  <!-- 工作区详情抽屉：展示该工作区包含哪些项目 -->
  <el-drawer
    v-model="workspaceDetailOpen"
    title="工作区详情"
    size="min(640px, 94vw)"
    @close="selectedWorkspace = null"
  >
    <template v-if="selectedWorkspace">
      <p class="eyebrow">WORKSPACE</p>
      <h2>{{ selectedWorkspace.name }}</h2>
      <div class="detail-grid">
        <span>目录</span><code>{{ selectedWorkspace.path }}</code>
        <span>工作区文件</span><code>{{ selectedWorkspace.workspaceFile || '缺少 .code-workspace' }}</code>
        <span>更新时间</span><strong>{{ formatWorkspaceTime(selectedWorkspace.updatedAt) }}</strong>
        <span>项目数</span><strong>{{ selectedWorkspace.projects.length }}</strong>
      </div>
      <section class="bug-detail-list">
        <h3>包含的项目</h3>
        <article v-for="project in selectedWorkspace.projects" :key="project.path" class="bug-detail">
          <div class="inbox-title-line">
            <strong>{{ project.name }}</strong>
            <span class="tag" :class="project.worktree ? 'tag-success' : 'tag-warning'">{{ project.worktree ? 'worktree' : '独立目录' }}</span>
          </div>
          <p><code>{{ project.path }}</code></p>
          <p>当前分支：{{ project.branch || '未知' }}</p>
        </article>
        <p v-if="!selectedWorkspace.projects.length" class="muted">该工作区目录下没有 git 项目。</p>
      </section>
      <section v-if="selectedWorkspace.missingProjects.length" class="bug-detail-list">
        <h3>工作区文件声明但目录缺失</h3>
        <p class="muted">{{ selectedWorkspace.missingProjects.join('、') }}</p>
      </section>
    </template>
    <template #footer>
      <el-button @click="selectedWorkspace = null">关闭</el-button>
    </template>
  </el-drawer>

  <!-- 新建工作区：项目通过可搜索的多选下拉选择 -->
  <el-dialog
    v-model="createDialogOpen"
    title="新建工作区"
    width="min(760px, 94vw)"
    :close-on-click-modal="false"
    :before-close="beforeCreateDialogClose"
  >
    <div class="workspace-form">
      <label>工作区名<el-input v-model="workspaceName" placeholder="ASCII 字母、数字、点、下划线或连字符" /></label>
      <label>分支名<el-input v-model="branch" placeholder="默认 feat/&lt;工作区名&gt;" /></label>
      <label>基线分支<el-input v-model="baseBranch" placeholder="默认 master" /></label>
      <label class="workspace-form-wide">
        <span>项目（可搜索、可多选）· {{ selectedRepositoryLabel }}</span>
        <el-select
          v-model="selectedRepositoryNames"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          :loading="candidatesLoading"
          placeholder="搜索并选择要加入工作区的项目"
        >
          <el-option v-for="candidate in repositoryCandidates" :key="candidate.path" :label="candidate.name" :value="candidate.name">
            <span>{{ candidate.name }}</span>
            <small class="option-hint">{{ candidate.path }}</small>
          </el-option>
        </el-select>
      </label>
      <label class="workspace-form-checks">
        <el-checkbox v-model="skipInstall">跳过 npm install</el-checkbox>
        <el-checkbox v-model="skipGraphify">跳过 graphify</el-checkbox>
      </label>
    </div>
    <div class="notice"><span class="notice-symbol">i</span><div><strong>只创建选中的项目</strong><p>正式创建会基于基线分支新建需求分支，把每个项目以 git worktree 检出到工作区目录，并写入 &lt;工作区名&gt;.code-workspace；不会 git pull、提交或删除远程分支。</p></div></div>
    <div v-if="workspaceError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>工作区任务异常</strong><p>{{ workspaceError }}</p></div></div>
    <section v-if="workspaceLogs.length || workspaceJob" class="workspace-output">
      <div class="section-heading">
        <div><h3>{{ workspaceJob ? `初始化：${workspaceJob.status} · ${workspaceJob.stage}` : 'DryRun 结果' }}</h3><p>DryRun 不执行文件或 Git 写入；正式执行的日志会持续刷新。</p></div>
        <span v-if="workspaceJob?.exitCode !== null && workspaceJob?.exitCode !== undefined" class="tag" :class="workspaceJob.exitCode === 0 ? 'tag-success' : 'tag-danger'">exit {{ workspaceJob.exitCode }}</span>
      </div>
      <pre>{{ workspaceLogs.join('\n') || '正在等待输出…' }}</pre>
    </section>
    <template #footer>
      <el-button :disabled="workspaceRunning" @click="closeCreateDialog">关闭</el-button>
      <el-button :loading="candidatesLoading" :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceRunning" @click="previewWorkspace">DryRun 预演</el-button>
      <el-button type="primary" :loading="workspaceRunning" :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceRunning" @click="startWorkspace">确认并创建</el-button>
    </template>
  </el-dialog>

  <!-- 删除工作区：必须输入“确认删除” -->
  <el-dialog v-model="deleteDialogOpen" title="删除工作区" width="min(600px, 94vw)" :close-on-click-modal="false" @close="closeDeleteDialog">
    <template v-if="workspacePendingDelete">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="删除后不可恢复"
        description="将执行 git worktree remove 并删除工作区目录；不会删除本地分支，也不会删除远程分支。"
      />
      <div class="detail-grid">
        <span>工作区</span><strong>{{ workspacePendingDelete.name }}</strong>
        <span>目录</span><code>{{ workspacePendingDelete.path }}</code>
        <span>项目</span><strong>{{ workspacePendingDelete.projects.map((project) => project.name).join('、') || '无' }}</strong>
      </div>
      <label class="delete-confirm-field">
        <span>请输入「{{ deleteConfirmationPhrase }}」以确认删除</span>
        <el-input v-model="deleteConfirmText" :placeholder="deleteConfirmationPhrase" />
      </label>
      <p v-if="deleteError" class="mapping-error" role="alert">{{ deleteError }}</p>
      <section v-if="deleteResult" class="workspace-output">
        <div class="section-heading"><div><h3>删除结果</h3><p>已移除 {{ deleteResult.removedWorktrees.length }} 个 worktree 登记，删除 {{ deleteResult.removedDirectories.length }} 个目录。</p></div></div>
        <pre>{{ deleteResult.logs.join('\n') }}</pre>
        <p v-if="deleteResult.warnings.length" class="mapping-error">{{ deleteResult.warnings.join('；') }}</p>
      </section>
    </template>
    <template #footer>
      <el-button :disabled="deleting" @click="closeDeleteDialog">{{ deleteResult ? '关闭' : '取消' }}</el-button>
      <el-button type="danger" :loading="deleting" :disabled="!canConfirmDelete || deleting || Boolean(deleteResult)" @click="confirmDeleteWorkspace">确认删除</el-button>
    </template>
  </el-dialog>
</template>
