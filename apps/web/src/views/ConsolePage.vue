<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Files } from '@element-plus/icons-vue'
import {
  applicationMappingSchema,
  mergeRequestSchema,
  repositoryCandidateSchema,
  resumableSessionSchema,
  workspaceInitializationJobSchema,
  workspacePreviewSchema,
  type Requirement,
  type ApplicationMapping,
  type Job,
  type MergeRequest,
  type RepositoryCandidate,
  type WorkspaceInitializationJob,
  type WorkspacePreview,
} from '@devtask/shared'
import { z } from 'zod'
import { useRoute } from 'vue-router'
import { ApiError, apiRequest } from '../api/client'
import { useConsoleStore } from '../stores/console'

const route = useRoute()
const store = useConsoleStore()
const selectedRequirement = ref<Requirement | null>(null)
const selectedBugs = computed(() => store.snapshot?.bugs.filter((bug) => bug.storyId === selectedRequirement.value?.storyId) ?? [])
const selectedHarnessBugs = computed(() => store.snapshot?.harnessBugs.filter((bug) => bug.storyId === selectedRequirement.value?.storyId) ?? [])
const selectedQuestions = computed(() => store.snapshot?.openQuestions.filter((question) => question.storyId === selectedRequirement.value?.storyId) ?? [])
const tapdAvailable = computed(() => store.snapshot?.channels.tapd?.ok ?? false)
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
const mappingDrafts = ref<Record<string, {
  gitlabProjectId?: number
  devopsApp: string
  devopsGroup: string
  projects: Array<{ id: number; pathWithNamespace: string }>
  loadingProjects: boolean
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
const crons = computed(() => store.snapshot?.crons ?? [])
const jobs = computed(() => [...(store.snapshot?.jobs ?? []), ...storyJobs.value])
const storyServiceRequirements = computed(() => requirements.value.filter((requirement) => requirement.workspacePath))
const activeWorkflows = computed(() => store.snapshot?.harnessActive ?? [])
const builds = computed(() => store.snapshot?.builds ?? [])
const branches = computed(() => store.snapshot?.branches ?? [])
const mergeRequests = computed(() => store.snapshot?.mergeRequests ?? [])
const channels = computed(() => Object.entries(store.snapshot?.channels ?? {}))
const pageHeading = computed(() => page.value === 'tools' ? '连接与配置' : String(route.meta.title ?? 'DevTask'))

watch([page, () => store.snapshot?.requirements.length], ([value]) => {
  if (value === 'workspaces') void refreshRepositoryCandidates()
  if (value === 'instances') void refreshStoryServices()
}, { immediate: true })

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
        devopsApp: saved?.devopsApp ?? '',
        devopsGroup: saved?.devopsGroup ?? 'JenkinsFrontweb',
        projects: [],
        loadingProjects: false,
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

async function saveApplicationMapping(repoName: string): Promise<void> {
  const draft = mappingDrafts.value[repoName]
  if (!draft) return
  draft.error = ''
  const input = {
    repoName,
    ...(draft.gitlabProjectId ? { gitlabProjectId: draft.gitlabProjectId } : {}),
    ...(draft.devopsApp.trim() ? { devopsApp: draft.devopsApp.trim(), devopsGroup: draft.devopsGroup.trim() } : {}),
  }
  const parsed = applicationMappingSchema.safeParse(input)
  if (!parsed.success) {
    draft.error = parsed.error.issues.map((issue) => issue.message).join(' ')
    return
  }
  try {
    applicationMappings.value = applicationMappingSchema.array().parse(await apiRequest<unknown>(
      '/api/v1/application-mappings',
      { method: 'PUT', body: JSON.stringify(parsed.data) },
    ))
  } catch (cause) {
    draft.error = cause instanceof Error ? cause.message : 'Unable to save application mapping.'
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
  if (!previewResult.value || previewResult.value.exitCode !== 0) return
  if (!window.confirm(`开始初始化工作区 ${workspaceName.value}？\n\n将创建所选仓库的 git worktree；未勾选的仓库不会处理。`)) return
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
      else if (workspaceJob.value.status === 'succeeded') await store.refresh()
    } catch (cause) {
      workspaceError.value = cause instanceof Error ? cause.message : 'Unable to read initialization progress.'
    }
  }, 1000)
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
        <div v-if="inbox.length" class="inbox-list">
          <article v-for="item in inbox" :key="item.id" class="inbox-row">
            <span class="priority-marker" :class="item.priority">{{ item.priority === 'high' ? '!' : '·' }}</span>
            <div class="inbox-copy"><div class="inbox-title-line"><strong>{{ item.title }}</strong><span class="kind-label">{{ item.kind.replaceAll('_', ' ') }}</span></div><p>{{ item.reason }}</p><small>{{ item.requirementId ? `需求 ${item.requirementId}` : '系统提醒' }}</small></div>
            <el-button type="primary" plain size="small" :disabled="!item.target" @click="item.target && $router.push(item.target)">查看处理</el-button>
          </article>
        </div>
        <div v-else class="empty-state"><span class="empty-icon">✓</span><strong>{{ store.error ? '连接数据源后显示待决策事项' : '现在没有需要你决策的事' }}</strong><p>{{ store.error ? '请先完成连接自检，或检查后端数据聚合器。' : '新出现的阻塞项、待确认项和失败构建会集中显示在这里。' }}</p></div>
      </section>
    </template>

    <template v-else-if="page === 'board'">
      <section class="surface">
        <div class="section-heading"><div><h2>需求总览</h2><p>需求、阶段、缺陷和关联工作区</p></div><el-input v-model="search" class="inline-search" placeholder="搜索标题或 ID" clearable /></div>
        <div v-if="requirements.length" class="requirement-list">
          <button v-for="item in requirements" :key="item.storyId" class="requirement-row" type="button" @click="openRequirement(item)">
            <div class="requirement-main"><strong>{{ item.title }}</strong><code>{{ item.storyId }}</code><span>{{ item.owner || '未分配' }} · {{ item.iterationName || '无迭代' }}</span></div>
            <div class="phase-track"><span v-for="step in 7" :key="step" :class="{ passed: (item.phase ?? -1) >= step - 1, current: item.phase === step - 1 }" /></div>
            <div class="requirement-badges"><span class="tag tag-warning">new {{ item.bugNew ?? 0 }}</span><span class="tag tag-danger">reopened {{ item.bugReopened ?? 0 }}</span></div>
          </button>
        </div>
        <div v-else class="empty-state"><strong>暂无需求数据</strong><p>{{ store.error ? '数据源尚未连接或聚合器未配置。' : '刷新后会显示 TAPD 需求和 Harness 阶段。' }}</p></div>
      </section>
    </template>

    <template v-else-if="page === 'pipeline'">
      <section class="surface">
        <div class="section-heading"><div><h2>端到端链路</h2><p>只展示源系统状态，不在此推进流程</p></div><span class="count-pill">{{ requirements.length }} 个需求</span></div>
        <div v-for="workflow in activeWorkflows" :key="`${workflow.workspacePath}:${workflow.storyId}`" class="notice notice-warning">
          <span class="notice-symbol">!</span>
          <div><strong>Harness 活跃流程：{{ workflow.title }}</strong><p>{{ workflow.storyId }} · {{ workflow.mode || '模式未知' }} · Phase {{ workflow.phase ?? '未知' }} · {{ workflow.status || '状态未知' }} · {{ workflow.workspacePath }}</p></div>
        </div>
        <article v-for="item in requirements" :key="item.storyId" class="pipeline-row" @click="openRequirement(item)">
          <div class="pipeline-title"><strong>{{ item.title }}</strong><code>{{ item.storyId }}</code></div>
          <div class="pipeline-steps"><span>工作区</span><i>→</i><span>Harness {{ item.phase === undefined ? '—' : `P${item.phase}` }}</span><i>→</i><span>MR</span><i>→</i><span>构建</span><i>→</i><span>部署</span></div>
          <el-icon class="row-arrow"><Files /></el-icon>
        </article>
        <div v-if="!requirements.length" class="empty-state"><strong>链路数据尚未就绪</strong><p>连接各数据源后，需求的工作区、Harness、MR、构建和部署状态会在此汇总。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'instances'">
      <div class="split-layout">
        <section class="surface split-list"><div class="section-heading"><div><h2>CodeBuddy 实例</h2><p>按 Story 与工作区关联</p></div><span class="count-pill">{{ jobs.length }}</span></div>
          <button v-for="job in jobs" :key="`${job.storyId}:${job.id}`" class="simple-list-row" :class="{ 'is-selected': selectedJob?.id === job.id }" type="button" :disabled="!job.storyId" @click="openJob(job)"><span class="status-dot" :class="job.status === 'busy' ? 'is-active' : ''" /><span><strong>{{ job.name }}</strong><small>{{ job.storyId }} · {{ job.cwd }}</small></span><code>{{ job.state }}</code></button>
          <div v-if="!jobs.length" class="empty-compact">尚无实例。连接 Story 服务后可从需求启动。</div>
          <div class="section-heading"><div><h3>Story 服务</h3><p>首次操作时按需启动，服务与执行轮次分开管理。</p></div></div>
          <div v-for="requirement in storyServiceRequirements" :key="requirement.storyId" class="simple-list-row">
            <span class="status-dot" :class="storyServices[requirement.storyId]?.status === 'running' ? 'is-active' : ''" />
            <span><strong>{{ requirement.title }}</strong><small>{{ requirement.storyId }} · {{ requirement.workspacePath }}</small></span>
            <span v-if="storyServices[requirement.storyId]" class="tag" :class="storyServices[requirement.storyId].status === 'running' ? 'tag-success' : 'tag-danger'">{{ storyServices[requirement.storyId].status }}</span>
            <template v-if="storyServices[requirement.storyId]?.status === 'running'">
              <el-button size="small" @click="prepareJob(requirement, 'run')">需求开发</el-button>
              <el-button size="small" type="warning" @click="prepareJob(requirement, 'fixbugs')">Bug 修复</el-button>
              <el-button size="small" @click="loadResumableSessions(requirement)">加载可恢复会话</el-button>
            </template>
            <el-button v-else size="small" type="primary" :loading="startingStoryService === requirement.storyId" :disabled="startingStoryService !== null" @click="startStoryService(requirement)">启动 / 接管</el-button>
            <small v-if="storyServices[requirement.storyId]?.error" class="mapping-error">{{ storyServices[requirement.storyId].error }}</small>
          </div>
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
      <section class="surface"><div class="section-heading"><div><h2>定时任务</h2><p>任务来自工作区 scheduled_tasks.json；这里只保存显式 Story、模式和 owner session 映射，不修改源任务。</p></div><span class="count-pill">{{ crons.length }} 个</span></div>
        <div v-for="cron in crons" :key="cron.id" class="cron-row">
          <div class="cron-primary">
            <strong>{{ cron.storyTitle || '未关联需求' }}</strong>
            <small><code>{{ cron.id }}</code> · {{ cron.storyId || 'Story 未映射' }} · {{ cron.mode === 'query_fix' ? '查询 + 修复' : cron.mode === 'query_only' ? '只查询' : '模式待确认' }} · owner {{ cron.ownerSessionId || '未关联' }}</small>
            <small v-if="cron.promptFirstLine">{{ cron.promptFirstLine }}</small>
            <small v-if="cron.mode === 'query_fix'" class="cron-risk">修复模式可能修改代码或写回 TAPD；当前控制台不触发 scheduled task。</small>
          </div>
          <code>{{ cron.cron }}</code>
          <span class="tag" :class="cron.enabled === true ? 'tag-success' : cron.enabled === false ? 'tag-warning' : ''">{{ cron.enabled === true ? '运行中' : cron.enabled === false ? '已暂停' : '状态未知' }}</span>
          <span>{{ cron.nextRun ? new Date(cron.nextRun).toLocaleString() : '下次运行未知' }}</span>
          <span v-if="cron.expiresAt">到期 {{ new Date(cron.expiresAt).toLocaleDateString() }}</span>
          <div class="cron-mapping" v-if="cronMappingDrafts[cron.id]">
            <span>{{ cron.storyId }} · {{ cron.storyTitle }}</span>
            <el-select v-model="cronMappingDrafts[cron.id].mode" placeholder="确认任务类型">
              <el-option label="只查询" value="query_only" />
              <el-option label="查询 + 修复" value="query_fix" />
            </el-select>
            <el-input v-model="cronMappingDrafts[cron.id].ownerSessionId" placeholder="专属 owner session ID" />
            <el-button type="primary" size="small" :loading="cronMappingDrafts[cron.id].saving" :disabled="!cronMappingDrafts[cron.id].ownerSessionId.trim() || !cronMappingDrafts[cron.id].mode" @click="saveCronMapping(cron.id)">保存 owner 映射</el-button>
            <p v-if="cronMappingDrafts[cron.id].error" class="mapping-error" role="alert">{{ cronMappingDrafts[cron.id].error }}</p>
          </div>
        </div>
        <div v-if="!crons.length" class="empty-state"><strong>暂无定时任务</strong><p>检查需求工作区中的 .codebuddy/scheduled_tasks.json。修改、暂停与删除保持禁用，直到 CodeBuddy scheduled-task API 语义经过验证。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'releases'">
      <div class="notice notice-danger"><span class="notice-symbol">!</span><div><strong>发布写操作暂不可用</strong><p>R16 部署数据口径和 R17 dev/test 关系尚待确认；自动化和手动写操作在确认前必须保持禁用。</p></div></div>
      <section class="surface"><div class="section-heading"><div><h2>构建与合并记录</h2><p>只读展示 GitLab MR 与 DevOps 构建事实</p></div></div>
        <div v-for="mr in mergeRequests" :key="`${mr.projectId}:${mr.id}`" class="release-row"><span class="tag">{{ mr.state }}</span><strong>{{ mr.title }}</strong><code>{{ mr.sourceBranch }} → {{ mr.targetBranch }}</code><span v-if="mr.mergeStatus">合并状态：{{ mr.mergeStatus }}</span><span v-if="mr.mergedAt">合并于 {{ new Date(mr.mergedAt).toLocaleString() }}</span><a v-if="mr.webUrl" :href="mr.webUrl" target="_blank" rel="noreferrer">打开 MR</a><el-button size="small" :loading="mergeRequestLoading" @click="openMergeRequest(mr)">详情</el-button></div>
        <p v-if="mergeRequestError" class="mapping-error" role="alert">{{ mergeRequestError }}</p>
        <div v-for="branchRecord in branches" :key="`${branchRecord.group}:${branchRecord.app}:${branchRecord.name}`" class="release-row"><span class="tag">{{ branchRecord.group || '分支' }}</span><strong>{{ branchRecord.app }}</strong><code>{{ branchRecord.name }} · {{ branchRecord.commitId || 'commit 未知' }}</code><span>{{ branchRecord.lastCommitTime ? new Date(branchRecord.lastCommitTime).toLocaleString() : '最后提交时间未知' }}</span></div>
        <div v-for="build in builds" :key="build.id" class="release-row"><span class="tag" :class="build.succeed === false ? 'tag-danger' : 'tag-success'">{{ build.succeed === null ? '运行中' : build.succeed ? '成功' : '失败' }}</span><strong>{{ build.app }}<small v-if="build.group"> · {{ build.group }}</small></strong><code>{{ build.number ? `#${build.number} · ` : '' }}{{ build.branch || '分支未知' }} · {{ build.commitId || 'commit 未知' }}</code><span>{{ build.buildDate ? new Date(build.buildDate).toLocaleString() : '时间未知' }}</span><span v-if="build.durationTime !== undefined || build.operator">{{ build.durationTime !== undefined ? `${build.durationTime}s` : '' }}{{ build.durationTime !== undefined && build.operator ? ' · ' : '' }}{{ build.operator || '' }}</span><a v-if="build.fileUrl" :href="build.fileUrl" target="_blank" rel="noreferrer">制品</a></div>
        <div v-if="!mergeRequests.length && !branches.length && !builds.length" class="empty-state"><strong>暂无发布记录</strong><p>GitLab 与 DevOps 连接后显示 MR、分支、构建与制品。当前页面不会触发外部写操作。</p></div>
      </section>
    </template>

    <template v-else-if="page === 'workspaces'">
      <section class="surface"><div class="section-heading"><div><h2>工作区</h2><p>仓库映射、初始化进度与结果复核</p></div></div>
        <div class="notice"><span class="notice-symbol">i</span><div><strong>创建前必须人工选择仓库</strong><p>候选来自配置的源仓库根目录；站点不会根据需求标题猜测仓库，也不会自动 git pull、提交或清理文件。</p></div></div>
        <div class="workspace-form">
          <label>工作区名<el-input v-model="workspaceName" placeholder="ASCII 字母、数字、点、下划线或连字符" /></label>
          <label>分支名<el-input v-model="branch" placeholder="默认 feat/&lt;工作区名&gt;" /></label>
          <label>基线分支<el-input v-model="baseBranch" placeholder="默认 master" /></label>
          <el-checkbox v-model="skipInstall">跳过 npm install</el-checkbox>
          <el-checkbox v-model="skipGraphify">跳过 graphify</el-checkbox>
        </div>
        <div class="section-heading"><div><h3>仓库候选</h3><p>已选择 {{ selectedRepositoryNames.length }} 个</p></div><el-button :loading="candidatesLoading" @click="refreshRepositoryCandidates()">重新扫描</el-button></div>
        <div v-if="candidatesError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>无法扫描仓库</strong><p>{{ candidatesError }}</p></div></div>
        <el-checkbox-group v-model="selectedRepositoryNames" class="repository-candidate-list">
          <div v-for="candidate in repositoryCandidates" :key="candidate.path" class="repository-candidate">
            <el-checkbox :value="candidate.name" />
            <span><strong>{{ candidate.name }}</strong><small>{{ candidate.path }}</small></span>
          </div>
        </el-checkbox-group>
        <div class="section-heading"><div><h3>源系统映射</h3><p>映射必须人工确认；GitLab 搜索结果不会自动采用。</p></div><el-button @click="loadApplicationMappings">刷新映射</el-button></div>
        <p v-if="mappingsError" class="notice notice-warning">{{ mappingsError }}</p>
        <div v-for="candidate in repositoryCandidates" :key="`mapping:${candidate.name}`" class="mapping-card">
          <strong>{{ candidate.name }}</strong>
          <div class="mapping-controls">
            <div class="mapping-control">
              <span>GitLab 项目</span>
              <div class="mapping-inline">
                <el-button size="small" :loading="mappingDrafts[candidate.name]?.loadingProjects" @click="searchGitLabProjects(candidate.name)">搜索</el-button>
                <el-select v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].gitlabProjectId" clearable filterable placeholder="请选择项目">
                  <el-option v-for="project in mappingDrafts[candidate.name].projects" :key="project.id" :label="project.pathWithNamespace" :value="project.id" />
                </el-select>
              </div>
            </div>
            <label class="mapping-control"><span>DevOps 分组</span><el-input v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].devopsGroup" /></label>
            <label class="mapping-control"><span>DevOps 应用</span><el-input v-if="mappingDrafts[candidate.name]" v-model="mappingDrafts[candidate.name].devopsApp" placeholder="人工填写应用名" /></label>
            <el-button size="small" type="primary" :disabled="!mappingDrafts[candidate.name]?.gitlabProjectId && !(mappingDrafts[candidate.name]?.devopsApp.trim() && mappingDrafts[candidate.name]?.devopsGroup.trim())" @click="saveApplicationMapping(candidate.name)">保存映射</el-button>
          </div>
          <small v-if="mappingDrafts[candidate.name]?.error" class="mapping-error">{{ mappingDrafts[candidate.name].error }}</small>
          <small v-else-if="applicationMappings.some((mapping) => mapping.repoName === candidate.name)" class="mapping-saved">已保存人工映射</small>
        </div>
        <div v-if="!candidatesLoading && !repositoryCandidates.length && !candidatesError" class="empty-state"><strong>未发现 Git 仓库</strong><p>检查源仓库根目录配置，或刷新扫描。</p></div>
        <div class="workspace-actions">
          <el-button :loading="candidatesLoading" :disabled="!workspaceName || !selectedRepositoryNames.length" @click="previewWorkspace">DryRun 预演</el-button>
          <el-button type="primary" :disabled="!previewResult || previewResult.exitCode !== 0 || workspaceJob?.status === 'running'" @click="startWorkspace">确认并初始化</el-button>
        </div>
        <div v-if="workspaceError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>工作区任务异常</strong><p>{{ workspaceError }}</p></div></div>
        <section v-if="previewResult || workspaceJob" class="workspace-output">
          <div class="section-heading"><div><h3>{{ workspaceJob ? `初始化：${workspaceJob.status} · ${workspaceJob.stage}` : 'DryRun 结果' }}</h3><p>DryRun 不执行文件或 Git 写入；正式执行的日志会持续刷新。</p></div><span v-if="workspaceJob?.exitCode !== null && workspaceJob?.exitCode !== undefined" class="tag" :class="workspaceJob.exitCode === 0 ? 'tag-success' : 'tag-danger'">exit {{ workspaceJob.exitCode }}</span></div>
          <pre>{{ (workspaceJob?.logs ?? previewResult?.logs ?? []).join('\n') || '正在等待输出…' }}</pre>
        </section>
      </section>
    </template>

    <template v-else>
      <div class="tool-grid">
        <section class="surface"><div class="section-heading"><div><h2>通道状态</h2><p>读取统一快照中的数据源健康状态</p></div><el-button :loading="store.loading" @click="store.refresh()">重新检测</el-button></div>
          <div v-for="[name, channel] in channels" :key="name" class="channel-row"><span class="status-dot" :class="channel.ok ? 'is-active' : 'is-error'" /><strong>{{ name }}</strong><span>{{ channel.ok ? '连接正常' : channel.error || '不可用' }}</span><small>{{ channel.fetchedAt ? new Date(channel.fetchedAt).toLocaleString() : '尚未检测' }}</small></div>
          <div v-if="!channels.length" class="empty-compact">聚合器配置完成后显示各通道检测结果。</div>
        </section>
        <section class="surface"><p class="eyebrow">LOCAL SECURITY</p><h2>本机信任边界</h2><p class="muted">控制台 API 由本地访问令牌保护。CodeBuddy 服务使用 <code>--auth none</code> 时，本机其他进程仍可能访问其高权限 API；Loopback 和请求标记不构成上游认证。</p></section>
      </div>
    </template>
  </section>

  <el-drawer v-model="detailOpen" title="需求详情" size="min(560px, 94vw)">
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
</template>
