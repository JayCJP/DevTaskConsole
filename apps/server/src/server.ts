import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  applicationMappingSchema,
  jobCreateRequestSchema,
  jobDetailSchema,
  jobPinRequestSchema,
  jobPrefsSchema,
  jobRenameRequestSchema,
  jobReplyRequestSchema,
  jobSchema,
  loginRequestSchema,
  resumableSessionSchema,
  snapshotSchema,
  workspaceBindingRequestSchema,
  workspaceDeleteRequestSchema,
  workspaceInitializationResumeRequestSchema,
  workspaceMergeRequestCreateRequestSchema,
  type Snapshot,
} from '@devtask/shared'
import { z } from 'zod'
import { buildSnapshot, getWorkspacesRoot } from './aggregator/snapshot.js'
import { buildBoard, defaultBoardOwner } from './aggregator/board.js'
import { DevOpsAdapter } from './integrations/devops.js'
import { GitLabAdapter } from './integrations/gitlab.js'
import { TapdAdapter } from './integrations/tapd.js'
import { ApplicationMappingStore } from './integrations/application-mappings.js'
import { CronMappingStore } from './aggregator/cron-data.js'
import { mcpClientRegistry } from './integrations/mcp-client.js'
import { getDataDirectory, loadOrCreateToken, tokenMatches } from './security/token-store.js'
import { listRepositoryCandidates } from './workspaces/repository-candidates.js'
import {
  deleteWorkspace,
  listWorkspaces,
  WorkspaceNotFoundError,
  WorkspaceRegistryInputError,
} from './workspaces/registry.js'
import {
  WorkspaceConflictError,
  WorkspaceDependencyError,
  WorkspaceInitializer,
  WorkspaceInputError,
  WorkspaceJobNotFoundError,
} from './workspaces/initializer.js'
import { createWorkspaceMergeRequests } from './workspaces/merge-requests.js'
import {
  normalizeTapdStoryId,
  WorkspaceBindingConflictError,
  WorkspaceBindingInputError,
  WorkspaceBindingStore,
} from './workspaces/bindings.js'
import { StoryServiceSupervisor, type StoryService } from './services/story-service-supervisor.js'
import { CodeBuddyApi, CodeBuddyApiError, extractJob, extractJobList, extractJobPrefs } from './services/codebuddy-api.js'
import { ScheduledTaskClient } from './services/scheduled-tasks.js'
import { CronExecutionReader } from './services/cron-executions.js'
import { AuditLog } from './services/audit-log.js'
import { CronDispatchStore } from './services/cron-dispatch.js'
import { ServiceMonitor } from './services/service-monitor.js'
import { registerCronRoutes } from './routes/crons.js'
import { registerServiceRoutes } from './routes/services.js'
import { registerAuditRoutes } from './routes/audit.js'
import { restoreCronOwners } from './services/cron-recovery.js'

export interface ServerOptions {
  token: string
  logger?: boolean
  snapshotProvider?: () => Promise<Snapshot>
  devOpsAdapter?: DevOpsAdapter
  gitLabAdapter?: GitLabAdapter
  tapdAdapter?: Pick<TapdAdapter, 'listOwnedStories'>
  applicationMappingStore?: ApplicationMappingStore
  cronMappingStore?: CronMappingStore
  workspaceBindingStore?: WorkspaceBindingStore
  workspaceInitializer?: WorkspaceInitializer
  storyServiceSupervisor?: StoryServiceSupervisor
  workspacesRoot?: string
  /** CodeBuddy 定时任务客户端；测试可注入桩 */
  scheduledTaskClient?: ScheduledTaskClient
  /** 站点派发轮次登记；测试可注入临时目录 */
  cronDispatchStore?: CronDispatchStore
  /** 审计流水；测试可注入临时目录 */
  auditLog?: AuditLog
  /** 运行期监督器；未注入时不暴露监督事件 */
  serviceMonitor?: ServiceMonitor
  /** 执行记录读取器；测试可注入桩 */
  cronExecutionReader?: CronExecutionReader
  /** CodeBuddy 原始 API；测试可注入桩，用于派发轮次等直连调用 */
  codeBuddyApi?: CodeBuddyApi
}

const storyIdSchema = z.string().min(1).max(200)
const jobIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true })
  // 容许「声明 application/json 但 body 为空」的写请求。
  // 部分客户端（含本站早期版本与 curl）会对无参数的 POST/DELETE 也带上 JSON 头，
  // Fastify 默认会返回 400 FST_ERR_CTP_EMPTY_JSON_BODY，导致启动/停止/续期这类无参数操作直接失败。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(text) as unknown)
    } catch (error) {
      // 显式标记为 400：默认 parser 不带 statusCode 时会退化成 500，
      // 前端只能看到「Internal Server Error」，无法判断是请求体写错了。
      const parseError = (error instanceof Error ? error : new Error('Invalid JSON body.')) as Error & {
        statusCode?: number
        code?: string
      }
      parseError.statusCode = 400
      parseError.code = 'FST_ERR_CTP_INVALID_JSON_BODY'
      done(parseError, undefined)
    }
  })
  const devOps = options.devOpsAdapter ?? new DevOpsAdapter()
  const gitLab = options.gitLabAdapter ?? new GitLabAdapter()
  const applicationMappings = options.applicationMappingStore ?? new ApplicationMappingStore()
  const cronMappings = options.cronMappingStore ?? new CronMappingStore()
  const workspaceBindings = options.workspaceBindingStore ?? new WorkspaceBindingStore()
  const tapd = options.tapdAdapter ?? new TapdAdapter()
  const workspaceInitializer = options.workspaceInitializer ?? new WorkspaceInitializer()
  const storyServiceSupervisor = options.storyServiceSupervisor ?? new StoryServiceSupervisor()
  const codeBuddyApi = options.codeBuddyApi ?? new CodeBuddyApi()
  const workspacesRoot = options.workspacesRoot ?? getWorkspacesRoot()
  app.addHook('onClose', async () => {
    await workspaceInitializer.flush()
    await mcpClientRegistry.close()
  })
  const snapshotProvider = options.snapshotProvider ?? buildSnapshot
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  const ensureStoryService = async (storyId: string): Promise<StoryService> => {
    const snapshot = await snapshotProvider()
    const requirement = snapshot.requirements.find((item) => item.storyId === storyId)
    if (!requirement?.workspacePath) {
      throw new StoryWorkspaceUnavailableError()
    }
    return storyServiceSupervisor.ensureRunning(
      storyId,
      resolve(workspacesRoot, requirement.workspacePath),
      workspacesRoot,
    )
  }
  const scheduledTasks = options.scheduledTaskClient ?? new ScheduledTaskClient(codeBuddyApi)
  const cronExecutions = options.cronExecutionReader ?? new CronExecutionReader(workspacesRoot, scheduledTasks)
  const auditLog = options.auditLog ?? new AuditLog()
  const cronDispatches = options.cronDispatchStore ?? new CronDispatchStore()

  // 定时任务、服务生命周期与审计三组路由共享同一套端口解析与审计流水
  registerCronRoutes(app, {
    snapshotProvider,
    workspacesRoot,
    supervisor: storyServiceSupervisor,
    client: scheduledTasks,
    api: codeBuddyApi,
    executions: cronExecutions,
    mappings: cronMappings,
    dispatches: cronDispatches,
    audit: auditLog,
  })
  registerServiceRoutes(app, {
    supervisor: storyServiceSupervisor,
    ...(options.serviceMonitor ? { monitor: options.serviceMonitor } : {}),
    mappings: cronMappings,
    client: scheduledTasks,
    dispatches: cronDispatches,
    audit: auditLog,
  })
  registerAuditRoutes(app, {
    audit: auditLog,
    snapshotProvider,
    supervisor: storyServiceSupervisor,
    client: scheduledTasks,
    mappings: cronMappings,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/auth/login') {
      return
    }
    if (!request.url.startsWith('/api/')) {
      return
    }

    const candidate = request.headers['x-devtask-token']
    if (typeof candidate !== 'string' || !tokenMatches(candidate, options.token)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid local access token is required.' } })
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body)
    if (!parsed.success || !tokenMatches(parsed.data.token, options.token)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'The access token is invalid.' } })
    }
    return { authenticated: true }
  })

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    service: 'devtask-console',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/v1/workspaces/candidates', async (request, reply) => {
    try {
      return await listRepositoryCandidates()
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN'
      request.log.error({ code }, 'Unable to list repository candidates')
      return reply.code(503).send({
        error: {
          code: 'SOURCE_ROOT_UNAVAILABLE',
          message: 'The configured source repository root is unavailable.',
        },
      })
    }
  })

  app.get('/api/v1/workspaces', async (request, reply) => {
    try {
      return await listWorkspaces(workspacesRoot)
    } catch (error) {
      request.log.error({ code: 'WORKSPACE_LIST_FAILED' }, 'Unable to list workspaces')
      return reply.code(503).send({
        error: {
          code: 'WORKSPACE_LIST_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Unable to list workspaces.',
        },
      })
    }
  })

  app.delete('/api/v1/workspaces/:name', async (request, reply) => {
    const params = z.object({ name: z.string().min(1).max(200) }).safeParse(request.params)
    const body = workspaceDeleteRequestSchema.safeParse(request.body)
    if (!params.success) return invalidParameters(reply)
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_CONFIRMATION',
          message: '请输入“确认删除”后才允许删除工作区。',
        },
      })
    }
    try {
      return await deleteWorkspace(workspacesRoot, params.data.name)
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return reply.code(404).send({
          error: { code: 'WORKSPACE_NOT_FOUND', message: error.message },
        })
      }
      if (error instanceof WorkspaceRegistryInputError) {
        return reply.code(400).send({
          error: { code: 'INVALID_WORKSPACE_REQUEST', message: error.message },
        })
      }
      request.log.error({ code: 'WORKSPACE_DELETE_FAILED' }, 'Unable to delete workspace')
      return reply.code(503).send({
        error: {
          code: 'WORKSPACE_DELETE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to delete workspace.',
        },
      })
    }
  })

  app.get('/api/v1/workspace-bindings', async (request, reply) => {
    try {
      return await workspaceBindings.list()
    } catch (error) {
      request.log.error({ code: 'WORKSPACE_BINDING_LIST_FAILED' }, 'Unable to list workspace bindings')
      return reply.code(503).send({
        error: {
          code: 'WORKSPACE_BINDING_LIST_FAILED',
          message: error instanceof Error ? error.message : 'Unable to list workspace bindings.',
        },
      })
    }
  })

  app.put('/api/v1/workspace-bindings', async (request, reply) => {
    const body = workspaceBindingRequestSchema.safeParse(request.body)
    if (!body.success) return invalidParameters(reply)
    try {
      const tapdStoryId = normalizeTapdStoryId(body.data.tapdStoryId)
      // 绑定目标必须是一个真实存在的工作区，避免保存指向空目录的映射
      const workspaces = await listWorkspaces(workspacesRoot)
      const target = workspaces.find((workspace) => workspace.name === body.data.workspaceName)
      if (!target) {
        return reply.code(404).send({
          error: {
            code: 'WORKSPACE_NOT_FOUND',
            message: `工作区不存在或未被 *.code-workspace 声明：${body.data.workspaceName}`,
          },
        })
      }
      return await workspaceBindings.upsert({
        tapdStoryId,
        workspaceName: target.name,
        ...(body.data.storyTitle ? { storyTitle: body.data.storyTitle } : {}),
        ...(body.data.tapdUrl ? { tapdUrl: body.data.tapdUrl } : {}),
      })
    } catch (error) {
      if (error instanceof WorkspaceBindingConflictError) {
        return reply.code(409).send({
          error: { code: 'WORKSPACE_BINDING_CONFLICT', message: error.message },
        })
      }
      if (error instanceof WorkspaceBindingInputError) {
        return reply.code(400).send({
          error: { code: 'INVALID_WORKSPACE_BINDING', message: error.message },
        })
      }
      if (error instanceof WorkspaceRegistryInputError) {
        return reply.code(503).send({
          error: { code: 'WORKSPACE_LIST_UNAVAILABLE', message: error.message },
        })
      }
      request.log.error({ code: 'WORKSPACE_BINDING_SAVE_FAILED' }, 'Unable to save workspace binding')
      return reply.code(503).send({
        error: {
          code: 'WORKSPACE_BINDING_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to save workspace binding.',
        },
      })
    }
  })

  app.delete('/api/v1/workspace-bindings/:tapdStoryId', async (request, reply) => {
    const params = z.object({ tapdStoryId: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      return await workspaceBindings.remove(params.data.tapdStoryId)
    } catch (error) {
      request.log.error({ code: 'WORKSPACE_BINDING_DELETE_FAILED' }, 'Unable to remove workspace binding')
      return reply.code(503).send({
        error: {
          code: 'WORKSPACE_BINDING_DELETE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to remove workspace binding.',
        },
      })
    }
  })

  app.get('/api/v1/board/stories', async (request, reply) => {
    const query = z.object({
      owner: z.string().trim().min(1).max(100).optional(),
      // 默认 0：排除“已发布”需求；传 1 才显示
      includeReleased: z.enum(['0', '1']).optional(),
    }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    const board = await buildBoard(
      query.data.owner ?? defaultBoardOwner,
      {
        tapd,
        bindings: workspaceBindings,
        workspaces: () => listWorkspaces(workspacesRoot),
      },
      { includeReleased: query.data.includeReleased === '1' },
    )
    return board
  })

  app.get('/api/v1/stories/:storyId/service', async (request, reply) => {
    const params = z.object({ storyId: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const service = await storyServiceSupervisor.inspect(params.data.storyId)
    if (!service) return reply.code(404).send({
      error: { code: 'STORY_SERVICE_NOT_FOUND', message: 'No CodeBuddy service has been assigned to this Story.' },
    })
    return publicStoryService(service)
  })

  app.get('/api/v1/stories/services', async () => {
    const services = await storyServiceSupervisor.inspectAll()
    return services.map(publicStoryService)
  })

  app.post('/api/v1/stories/:storyId/service', async (request, reply) => {
    const params = z.object({ storyId: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const snapshot = await snapshotProvider()
      const requirement = snapshot.requirements.find((item) => item.storyId === params.data.storyId)
      if (!requirement?.workspacePath) {
        return reply.code(409).send({
          error: {
            code: 'STORY_WORKSPACE_UNAVAILABLE',
            message: 'This Story has no associated workspace; initialize and associate its workspace first.',
          },
        })
      }
      const service = await storyServiceSupervisor.ensureRunning(
        requirement.storyId,
        resolve(workspacesRoot, requirement.workspacePath),
        workspacesRoot,
      )
      return reply.code(200).send(publicStoryService(service))
    } catch (error) {
      request.log.error({ code: 'STORY_SERVICE_START_FAILED' }, 'Unable to start Story CodeBuddy service')
      return reply.code(503).send({
        error: {
          code: 'STORY_SERVICE_START_FAILED',
          message: error instanceof Error ? error.message : 'Unable to start the Story CodeBuddy service.',
        },
      })
    }
  })

  app.get('/api/v1/stories/:storyId/jobs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await storyServiceSupervisor.inspect(params.data.storyId)
      if (!service) return []
      if (service.status !== 'running') {
        return reply.code(503).send({
          error: {
            code: 'STORY_SERVICE_UNAVAILABLE',
            message: service.error ?? 'Start or recover the Story service before listing jobs.',
          },
        })
      }
      const query = new URLSearchParams({ all: '1', cwd: service.cwd })
      const result = await codeBuddyApi.request(service.port, `/api/v1/jobs?${query}`, 'GET')
      const list = extractJobList(result)
      // 上游的 status 是可选字段：只在部分状态下输出。缺省时按 state 推导，
      // 否则整批实例会被判为「响应非法」，页面看不到任何实例。
      const normalized = (list ?? []).map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
        const record = item as Record<string, unknown>
        return { ...record, status: record.status ?? (record.state === 'working' ? 'busy' : 'idle') }
      })
      const parsed = jobSchema.array().safeParse(normalized)
      if (!parsed.success) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid jobs response.')
      return parsed.data.map((job) => ({ ...job, storyId: params.data.storyId }))
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    const body = jobCreateRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const result = await codeBuddyApi.request(service.port, '/api/v1/jobs', 'POST', {
        ...body.data,
        cwd: service.cwd,
      })
      return reply.code(201).send(result)
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  // 实例详情：比列表多出当前活动、等待原因与建议回复，用于多实例并排管理时看清每一个在做什么
  app.get('/api/v1/stories/:storyId/jobs/:jobId', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const result = await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}`,
        'GET',
      )
      const job = extractJob(result)
      const parsed = jobDetailSchema.safeParse({
        ...job,
        // 详情响应不带列表里的 status 字段，用 state 推导，保持与列表一致的 busy/idle 语义
        status: job?.status ?? (job?.state === 'working' ? 'busy' : 'idle'),
        storyId: params.data.storyId,
      })
      if (!parsed.success) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid job detail response.')
      return parsed.data
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  // 列表偏好（置顶/分组）由 CodeBuddy 自己持久化，本站不另存一份
  app.get('/api/v1/stories/:storyId/jobs/prefs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const result = await codeBuddyApi.request(service.port, '/api/v1/jobs/prefs', 'GET')
      const prefs = jobPrefsSchema.parse(extractJobPrefs(result))
      return prefs
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.put('/api/v1/stories/:storyId/jobs/prefs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    const body = z.object({ id: jobIdSchema, ...jobPinRequestSchema.shape }).safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const result = await codeBuddyApi.request(service.port, '/api/v1/jobs/prefs', 'PUT', [
        { op: 'pin', id: body.data.id, pinned: body.data.pinned },
      ])
      return jobPrefsSchema.parse(extractJobPrefs(result))
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/:jobId/transcript', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/transcript`,
        'GET',
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/:jobId/stream', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const lastEventIdHeader = request.headers['last-event-id']
    if (
      Array.isArray(lastEventIdHeader)
      || (lastEventIdHeader !== undefined && (lastEventIdHeader.length > 500 || /[\r\n]/.test(lastEventIdHeader)))
    ) return invalidParameters(reply)
    const controller = new AbortController()
    reply.raw.once('close', () => controller.abort())
    try {
      const service = await ensureStoryService(params.data.storyId)
      const upstream = await codeBuddyApi.openStream(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/stream`,
        controller.signal,
        lastEventIdHeader,
      )
      if (!upstream.body) throw new CodeBuddyApiError(502, 'CodeBuddy returned an empty event stream.')
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      await pipeline(Readable.from(upstream.body), reply.raw)
    } catch (error) {
      if (reply.sent) return
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/reply', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    const body = jobReplyRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/reply`,
        'POST',
        body.data,
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/stop', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}/stop`,
      method: 'POST',
    }), ensureStoryService, codeBuddyApi)
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/respawn', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}/respawn`,
      method: 'POST',
    }), ensureStoryService, codeBuddyApi)
  })

  app.delete('/api/v1/stories/:storyId/jobs/:jobId', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}`,
      method: 'DELETE',
    }), ensureStoryService, codeBuddyApi)
  })

  app.patch('/api/v1/stories/:storyId/jobs/:jobId/name', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    const body = jobRenameRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/name`,
        'PATCH',
        body.data,
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/resumable', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const query = new URLSearchParams({ cwd: service.cwd })
      const result = await codeBuddyApi.request(service.port, `/api/v1/jobs/resumable?${query}`, 'GET')
      const parsed = resumableSessionSchema.array().safeParse(result)
      if (!parsed.success) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid resumable sessions response.')
      return parsed.data
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/resume', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    const body = z.object({ sessionId: z.string().min(1).max(200) }).safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const query = new URLSearchParams({ cwd: service.cwd })
      const resumable = await codeBuddyApi.request(service.port, `/api/v1/jobs/resumable?${query}`, 'GET')
      if (!isResumableSession(resumable, body.data.sessionId)) {
        return reply.code(409).send({
          error: {
            code: 'SESSION_NOT_RESUMABLE_FOR_STORY',
            message: 'The requested session is not listed as resumable in this Story workspace.',
          },
        })
      }
      return reply.code(201).send(await codeBuddyApi.request(
        service.port,
        '/api/v1/jobs/resume',
        'POST',
        body.data,
      ))
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/application-mappings', async (request, reply) => {
    try {
      return await applicationMappings.list()
    } catch (error) {
      request.log.error({ code: 'APPLICATION_MAPPING_READ_FAILED' }, 'Unable to read application mappings')
      return reply.code(503).send({
        error: {
          code: 'APPLICATION_MAPPING_READ_FAILED',
          message: error instanceof Error ? error.message : 'Unable to read application mappings.',
        },
      })
    }
  })

  app.put('/api/v1/application-mappings', async (request, reply) => {
    const parsed = applicationMappingSchema.safeParse(request.body)
    if (!parsed.success) return invalidParameters(reply)
    try {
      return await applicationMappings.upsert(parsed.data)
    } catch (error) {
      request.log.error({ code: 'APPLICATION_MAPPING_WRITE_FAILED' }, 'Unable to save application mapping')
      return reply.code(503).send({
        error: {
          code: 'APPLICATION_MAPPING_WRITE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to save application mapping.',
        },
      })
    }
  })

  app.delete('/api/v1/application-mappings/:repoName', async (request, reply) => {
    const params = z.object({ repoName: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      return await applicationMappings.remove(params.data.repoName)
    } catch (error) {
      request.log.error({ code: 'APPLICATION_MAPPING_DELETE_FAILED' }, 'Unable to remove application mapping')
      return reply.code(503).send({
        error: {
          code: 'APPLICATION_MAPPING_DELETE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to remove application mapping.',
        },
      })
    }
  })

  app.post('/api/v1/workspaces/initialize/preview', async (request, reply) => {
    try {
      return await workspaceInitializer.preview(request.body)
    } catch (error) {
      return workspaceInitializationError(request, reply, error)
    }
  })

  app.post('/api/v1/workspaces/initialize', async (request, reply) => {
    try {
      const job = await workspaceInitializer.start(request.body)
      return reply.code(202).send(job)
    } catch (error) {
      return workspaceInitializationError(request, reply, error)
    }
  })

  app.get('/api/v1/workspaces/initialize/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const job = await workspaceInitializer.getJob(params.data.jobId)
    if (!job) return reply.code(404).send({
      error: { code: 'WORKSPACE_JOB_NOT_FOUND', message: 'Workspace initialization job was not found.' },
    })
    return job
  })

  app.post('/api/v1/workspaces/initialize/:jobId/resume', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params)
    const body = workspaceInitializationResumeRequestSchema.safeParse(request.body)
    if (!params.success) return invalidParameters(reply)
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_CONFIRMATION',
          message: '续跑会以同一参数重新执行脚本，需要明确确认后才允许发起。',
        },
      })
    }
    try {
      return await workspaceInitializer.resume(params.data.jobId)
    } catch (error) {
      if (error instanceof WorkspaceJobNotFoundError) {
        return reply.code(404).send({ error: { code: 'WORKSPACE_JOB_NOT_FOUND', message: error.message } })
      }
      return workspaceInitializationError(request, reply, error)
    }
  })

  // 工作区创建合并请求：源分支取各项目当前检出分支，目标分支限定为约定的基线分支；
  // 不传 projects 时对工作区全部项目创建，传了则只处理指定项目（一键创建即不传）
  app.post('/api/v1/workspaces/:name/merge-requests', async (request, reply) => {
    const params = z.object({ name: z.string().min(1).max(200) }).safeParse(request.params)
    const body = workspaceMergeRequestCreateRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      return await createWorkspaceMergeRequests(workspacesRoot, params.data.name, body.data, {
        gitlab: gitLab,
        mappings: applicationMappings,
      })
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: error.message } })
      }
      request.log.error({ code: 'WORKSPACE_MERGE_REQUEST_FAILED' }, 'Unable to create workspace merge requests')
      return reply.code(502).send({
        error: {
          code: 'WORKSPACE_MERGE_REQUEST_UNAVAILABLE',
          message: error instanceof Error ? error.message : '创建工作区合并请求失败。',
        },
      })
    }
  })

  app.get('/api/v1/devops/groups', async (request, reply) => {
    return relayRead(request, reply, 'DevOps', () => devOps.getGroups())
  })

  app.get('/api/v1/devops/groups/:group/applications', async (request, reply) => {
    const params = z.object({ group: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () => devOps.getApplications(params.data.group))
  })

  app.get('/api/v1/devops/apps/:app/branches', async (request, reply) => {
    const params = z.object({ app: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () => devOps.getBranches(params.data.app))
  })

  app.get('/api/v1/devops/apps/:app/builds', async (request, reply) => {
    const params = z.object({ app: z.string().min(1).max(200) }).safeParse(request.params)
    const query = z.object({
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(request.query)
    if (!params.success || !query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () =>
      devOps.getBuildRecords(params.data.app, query.data.pageNo, query.data.pageSize))
  })

  app.get('/api/v1/gitlab/projects', async (request, reply) => {
    const query = z.object({ search: z.string().min(1).max(200) }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () => gitLab.findProjects(query.data.search))
  })

  app.get('/api/v1/gitlab/projects/:projectId/merge-requests', async (request, reply) => {
    const params = z.object({ projectId: z.coerce.number().int().positive() }).safeParse(request.params)
    const query = z.object({ sourceBranch: z.string().min(1).max(250) }).safeParse(request.query)
    if (!params.success || !query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () =>
      gitLab.listMergeRequests(params.data.projectId, query.data.sourceBranch))
  })

  app.get('/api/v1/gitlab/projects/:projectId/merge-requests/:iid', async (request, reply) => {
    const params = z.object({
      projectId: z.coerce.number().int().positive(),
      iid: z.string().min(1).max(100),
    }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () =>
      gitLab.getMergeRequestDetails(params.data.projectId, params.data.iid))
  })

  app.get('/api/v1/gitlab/projects/:projectId/merge-requests/:iid/diff-summary', async (request, reply) => {
    const params = z.object({
      projectId: z.coerce.number().int().positive(),
      iid: z.string().min(1).max(100),
    }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () =>
      gitLab.getMergeRequestDiffSummary(params.data.projectId, params.data.iid))
  })

  app.get('/api/v1/release/facts', async (request, reply) => {
    const query = z.object({ app: z.string().trim().min(1).max(200) }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    return devOps.getReleaseFacts(query.data.app)
  })

  app.get('/api/v1/snapshot', async (request, reply) => {
    const snapshot = await snapshotProvider()
    const parsed = snapshotSchema.safeParse(snapshot)
    if (!parsed.success) {
      request.log.error({ issues: parsed.error.issues }, 'Snapshot validation failed')
      // 只回传字段路径，便于定位上游格式问题，不回传任何字段值
      const fieldPaths = [...new Set(parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .filter((path) => path.length > 0))].slice(0, 8)
      return reply.code(500).send({
        error: {
          code: 'INVALID_SNAPSHOT',
          message: fieldPaths.length
            ? `The data aggregator returned an invalid snapshot. Fields: ${fieldPaths.join(', ')}`
            : 'The data aggregator returned an invalid snapshot.',
        },
      })
    }
    return parsed.data
  })

  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API route not found.' } })
      }
      return reply.type('text/html').sendFile('index.html')
    })
  }

  return app
}

function publicStoryService(service: StoryService): {
  storyId: string
  port: number
  cwd: string
  status: StoryService['status']
  updatedAt: string
  error?: string
} {
  return {
    storyId: service.storyId,
    port: service.port,
    cwd: service.cwd,
    status: service.status,
    updatedAt: service.updatedAt,
    ...(service.error ? { error: service.error } : {}),
  }
}

async function relayCodeBuddyJob(
  request: FastifyRequest,
  reply: FastifyReply,
  buildTarget: (params: { storyId: string; jobId: string }) => {
    serviceId: string
    path: string
    method: 'POST' | 'DELETE'
  },
  ensureStoryService: (storyId: string) => Promise<StoryService>,
  api: CodeBuddyApi,
): Promise<unknown> {
  const parsed = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
  if (!parsed.success) return invalidParameters(reply)
  try {
    const target = buildTarget(parsed.data)
    const service = await ensureStoryService(target.serviceId)
    return await api.request(service.port, target.path, target.method)
  } catch (error) {
    return codeBuddyError(request, reply, error)
  }
}

function codeBuddyError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (reply.raw.destroyed) return undefined
  if (error instanceof StoryWorkspaceUnavailableError) {
    return reply.code(409).send({
      error: { code: 'STORY_WORKSPACE_UNAVAILABLE', message: error.message },
    })
  }
  const isUpstream = error instanceof CodeBuddyApiError
  const status = isUpstream ? 502 : 503
  request.log.error({
    code: isUpstream ? 'CODEBUDDY_UPSTREAM_ERROR' : 'STORY_SERVICE_UNAVAILABLE',
    ...(isUpstream ? { upstreamStatus: error.status } : {}),
  }, 'CodeBuddy API request failed')
  return reply.code(status).send({
    error: {
      code: isUpstream ? 'CODEBUDDY_UPSTREAM_ERROR' : 'STORY_SERVICE_UNAVAILABLE',
      message: error instanceof Error ? error.message : 'CodeBuddy API request failed.',
    },
  })
}

function isResumableSession(value: unknown, sessionId: string): boolean {
  return Array.isArray(value) && value.some((entry) =>
    typeof entry === 'object'
    && entry !== null
    && !Array.isArray(entry)
    && 'sessionId' in entry
    && entry.sessionId === sessionId)
}

class StoryWorkspaceUnavailableError extends Error {
  constructor() {
    super('This Story has no associated workspace; initialize and associate its workspace first.')
    this.name = 'StoryWorkspaceUnavailableError'
  }
}

async function relayRead(
  request: FastifyRequest,
  reply: FastifyReply,
  channel: 'DevOps' | 'GitLab',
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : `${channel} request failed.`
    const expiredSession = channel === 'DevOps' && message.includes('session expired')
    request.log.error({ channel, code: expiredSession ? 'SESSION_EXPIRED' : 'UPSTREAM_ERROR' }, 'Read-only upstream request failed')
    return reply.code(expiredSession ? 403 : 502).send({
      error: {
        code: expiredSession ? 'DEVOPS_SESSION_EXPIRED' : 'UPSTREAM_ERROR',
        message: expiredSession ? message : `${channel} request failed. Check the connection status and server logs.`,
      },
    })
  }
}

function invalidParameters(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: { code: 'INVALID_PARAMETERS', message: 'The request parameters are invalid.' },
  })
}

function workspaceInitializationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof WorkspaceInputError) {
    return reply.code(400).send({ error: { code: 'INVALID_WORKSPACE_REQUEST', message: error.message } })
  }
  if (error instanceof WorkspaceConflictError) {
    return reply.code(409).send({ error: { code: 'WORKSPACE_JOB_CONFLICT', message: error.message } })
  }
  const dependency = error instanceof WorkspaceDependencyError
  const code = dependency ? 'WORKSPACE_DEPENDENCY_UNAVAILABLE' : 'WORKSPACE_INITIALIZATION_UNAVAILABLE'
  const message = error instanceof Error ? error.message : 'Workspace initialization failed.'
  request.log.error({ code }, 'Workspace initialization request failed')
  return reply.code(503).send({ error: { code, message } })
}

export async function startServer(): Promise<void> {
  const token = await loadOrCreateToken()
  const storyServiceSupervisor = new StoryServiceSupervisor()
  const workspacesRoot = getWorkspacesRoot()
  const cronMappings = new CronMappingStore()
  const scheduledTasks = new ScheduledTaskClient()
  const auditLog = new AuditLog()
  const serviceMonitor = new ServiceMonitor({ supervisor: storyServiceSupervisor, workspacesRoot })
  const app = buildServer({
    token,
    storyServiceSupervisor,
    workspacesRoot,
    cronMappingStore: cronMappings,
    scheduledTaskClient: scheduledTasks,
    auditLog,
    serviceMonitor,
  })
  const port = Number(process.env.PORT ?? 7788)
  const host = process.env.HOST ?? '127.0.0.1'

  app.addHook('onClose', async () => {
    serviceMonitor.stop()
  })

  await app.listen({ port, host })
  app.log.info({ host, port, dataDirectory: getDataDirectory() }, 'DevTask Console server started')
  serviceMonitor.start()

  void (async () => {
    try {
      await storyServiceSupervisor.recoverPersistedServices(workspacesRoot)
      // 恢复顺序固定：先恢复服务与 owner，再重新启用被停服暂停的任务
      const result = await restoreCronOwners({
        mappings: cronMappings,
        supervisor: storyServiceSupervisor,
        client: scheduledTasks,
        log: (message) => app.log.info({ code: 'CRON_OWNER_RECOVERY' }, message),
      })
      if (result.restored.length || result.failed.length) {
        app.log.info(
          { restored: result.restored.length, skipped: result.skipped.length, failed: result.failed.length },
          'Cron owner recovery finished',
        )
      }
    } catch (error) {
      app.log.error({ error }, 'Unable to recover persisted Story services')
    }
  })()
}

const serverEntrypoint = fileURLToPath(import.meta.url)
if (process.argv.slice(1).some((argument) => resolve(argument) === serverEntrypoint)) {
  await startServer()
}
