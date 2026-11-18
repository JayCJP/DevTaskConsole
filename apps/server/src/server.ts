import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import multipart from '@fastify/multipart'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  applicationMappingSchema,
  buildEnvironmentSpecs,
  buildTriggerRequestSchema,
  buildTriggerResultSchema,
  defaultTapdWorkspaceId,
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
  type BoardResponse,
  type Snapshot,
} from '@devtask/shared'
import { z } from 'zod'
import {
  buildCronFacts,
  createCachedSnapshotProvider,
  getWorkspacesRoot,
  type CronFacts,
  type SnapshotCacheStore,
} from './aggregator/snapshot.js'
import { SnapshotCache } from './aggregator/snapshot-cache.js'
import { buildBoard, defaultBoardOwner } from './aggregator/board.js'
import { BoardCache, createCachedBoardProvider, type BoardCacheStore } from './aggregator/board-cache.js'
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
import { createHerdrLifecycle, createHerdrRunner, resolveStoryServiceLauncher } from './services/herdr-story-service.js'
import { CodeBuddyApi, CodeBuddyApiError, extractJob, extractJobList, extractJobPrefs } from './services/codebuddy-api.js'
import { ScheduledTaskClient } from './services/scheduled-tasks.js'
import { CronExecutionReader } from './services/cron-executions.js'
import { AuditLog } from './services/audit-log.js'
import { CronDispatchStore } from './services/cron-dispatch.js'
import { ServiceMonitor } from './services/service-monitor.js'
import { registerCronRoutes } from './routes/crons.js'
import { registerServiceRoutes } from './routes/services.js'
import { registerAuditRoutes } from './routes/audit.js'
import { registerStoryRoutes } from './routes/stories.js'
import { restoreCronOwners } from './services/cron-recovery.js'

export interface ServerOptions {
  token: string
  logger?: boolean
  /** 快照构建器；`force` 为 true 时强制重建缓存段并刷新连通性。注入后完全接管，不套磁盘缓存 */
  snapshotProvider?: (force?: boolean) => Promise<Snapshot>
  /** 快照磁盘缓存；测试可注入内存替身 */
  snapshotCache?: SnapshotCacheStore
  /** 看板 provider；注入后完全接管（不套文件缓存），测试可注入替身 */
  boardProvider?: (owner: string, includeReleased: boolean, force?: boolean) => Promise<BoardResponse>
  /** 看板文件缓存；测试可注入内存替身 */
  boardCache?: BoardCacheStore
  /** 只读定时任务事实的构建器，测试时可注入替身 */
  cronFactsProvider?: () => Promise<CronFacts>
  devOpsAdapter?: DevOpsAdapter
  gitLabAdapter?: GitLabAdapter
  tapdAdapter?: Pick<TapdAdapter, 'listOwnedStories' | 'resolveParentStoryId'>
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

/**
 * 构造 Story 服务监督器。
 * 默认由 herdr 的持久 pane 托管进程：服务不随启动它的终端窗口消失，
 * 也不会在 Windows 上弹出独立控制台窗口。
 * 设置 `DEVTASK_STORY_LAUNCHER=spawn` 可回退到内置的 detached 实现。
 * 两种实现共用同一套端口分配、健康检查、退避重启与注册表逻辑。
 * @returns 已装配启动/停止实现的监督器
 */
function createStoryServiceSupervisor(): StoryServiceSupervisor {
  if (resolveStoryServiceLauncher() === 'spawn') return new StoryServiceSupervisor()
  const lifecycle = createHerdrLifecycle(createHerdrRunner())
  return new StoryServiceSupervisor({
    launch: lifecycle.launch,
    killProcessTree: lifecycle.stop,
  })
}

const storyIdSchema = z.string().min(1).max(200)
const jobIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
/**
 * 用于拼接上传目录的严格 Story ID：只允许字母、数字、点、下划线与连字符。
 * 拒绝 `..` 与任意路径分隔符，防止写入 `.docs/<storyId>/` 时发生路径穿越。
 */
const uploadStoryIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/)
/** 上传文件的扩展名安全规则：点 + 1~16 位字母数字，覆盖任意类型同时排除路径穿越字符 */
const uploadExtensionPattern = /^\.[A-Za-z0-9]{1,16}$/

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true })
  // 文件上传走 multipart：单文件 10MB、单次最多 5 个，超限由插件直接返回 413。
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  })
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
  const storyServiceSupervisor = options.storyServiceSupervisor ?? createStoryServiceSupervisor()
  const codeBuddyApi = options.codeBuddyApi ?? new CodeBuddyApi()
  const workspacesRoot = options.workspacesRoot ?? getWorkspacesRoot()
  app.addHook('onClose', async () => {
    await workspaceInitializer.flush()
    await mcpClientRegistry.close()
  })
  // 多个页面/标签页可能同时请求快照：并发时共享同一次构建，避免重复打 TAPD/GitLab/DevOps。
  // 注入的 provider 直接单飞；默认 provider 先读写磁盘缓存再单飞，force/non-force 按参数分 key。
  const snapshotProvider = createSingleFlight(
    options.snapshotProvider
      ?? createCachedSnapshotProvider({
        workspacesRoot,
        cache: options.snapshotCache ?? new SnapshotCache(),
        logError: (message) => app.log.error({ code: 'SNAPSHOT_CACHE_WRITE_FAILED' }, message),
      }),
  )
  // 定时任务只读事实：并发去重，且完全不触达上游系统
  const cronFactsProvider = createSingleFlight(
    options.cronFactsProvider ?? (() => buildCronFacts(workspacesRoot)),
  )
  // 看板 provider：普通请求命中文件缓存直返（零 MCP），force 穿透；并发同 key 单飞去重。
  // 注入的 provider 直接单飞；默认 provider 先读写文件缓存再单飞，force/non-force 按参数分 key。
  const boardProvider = createSingleFlight(
    options.boardProvider ?? createCachedBoardProvider({
      cache: options.boardCache ?? new BoardCache(),
      build: (owner, includeReleased) => buildBoard(owner, {
        tapd,
        bindings: workspaceBindings,
        workspaces: () => listWorkspaces(workspacesRoot),
      }, { includeReleased }),
      logError: (message) => app.log.error({ code: 'BOARD_CACHE_WRITE_FAILED' }, message),
    }),
  )
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  const ensureStoryService = async (storyId: string): Promise<StoryService> => {
    // 显式传 false：与快照接口的非强制请求共用同一次构建（单飞按参数区分）
    const snapshot = await snapshotProvider(false)
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
    cronFacts: cronFactsProvider,
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
    cronFacts: cronFactsProvider,
    supervisor: storyServiceSupervisor,
    client: scheduledTasks,
    mappings: cronMappings,
  })
  // 空工作区从 0 到 1：创建最小 Story 骨架，供实例页启动 CodeBuddy 后用 /start 补全
  registerStoryRoutes(app, {
    workspacesRoot,
    audit: auditLog,
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
      const normalizedId = normalizeTapdStoryId(body.data.tapdStoryId)
      // 工作区绑定统一挂在父需求上：粘贴子需求链接时解析为其父需求 ID
      const tapdStoryId = await tapd.resolveParentStoryId(normalizedId)
      const tapdUrl = tapdStoryId === normalizedId
        ? body.data.tapdUrl
        : `https://www.tapd.cn/${defaultTapdWorkspaceId}/prong/stories/view/${tapdStoryId}`
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
        ...(tapdUrl ? { tapdUrl } : {}),
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
      // refresh=1 时穿透文件缓存，强制回源重建
      refresh: z.enum(['0', '1']).optional(),
    }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    const includeReleased = query.data.includeReleased === '1'
    const board = await boardProvider(
      query.data.owner ?? defaultBoardOwner,
      includeReleased,
      query.data.refresh === '1',
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
      const snapshot = await snapshotProvider(false)
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

  /**
   * 上传任意类型文件到 Story 所在项目的 `.docs/<storyId>/` 目录。
   *
   * 路径解析：storyId → requirement.workspacePath（相对工作区根）→ service.cwd（项目根，已做 containment 校验）
   * 再拼 `.docs/<storyId>/<原始文件名>`。落盘名直接采用上传的源文件名（含中文/空格原样保留），
   * 同名文件直接覆盖。Fastify multipart 解析时已剥除文件名里的路径分隔符，故这里不再做额外清洗。
   * 文件类型不限，仅要求扩展名为「点 + 字母数字」。
   *
   * @param request  multipart 请求，文件字段名为 `file`
   * @param reply    Fastify 回复
   * @returns 201 + { name, originalName, mimeType, relativePath, absolutePath }；失败返回对应错误码
   */
  app.post('/api/v1/stories/:storyId/uploads', async (request, reply) => {
    const params = z.object({ storyId: uploadStoryIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const storyId = params.data.storyId
    try {
      // ensureStoryService 内部已做 snapshot 查询 + workspace containment 校验，
      // 返回的 cwd 即 Story 所在项目根目录（如 ...\CustomerServiceSystem）。
      const service = await ensureStoryService(storyId)
      const projectRoot = service.cwd

      // 拼目标目录并做越界兜底：确保 `.docs/<storyId>` 仍落在项目根之内。
      const targetDir = resolve(projectRoot, '.docs', storyId)
      const fromRoot = relative(projectRoot, targetDir)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        return reply.code(400).send({
          error: { code: 'INVALID_UPLOAD_PATH', message: 'Invalid upload path.' },
        })
      }

      let part: Awaited<ReturnType<typeof request.file>>
      try {
        part = await request.file()
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: 'UPLOAD_PARSE_FAILED',
            message: error instanceof Error ? error.message : 'Unable to read uploaded file.',
          },
        })
      }
      if (!part) return invalidParameters(reply)

      // 保留源文件名：Fastify multipart 解析时已剥除文件名里的路径分隔符，
      // 这里直接采用 part.filename 原样落盘（含中文/空格），同名文件后续直接覆盖。
      // 仅校验扩展名为「点 + 字母数字」，拒绝无扩展名的文件。
      const extension = extname(part.filename).toLowerCase()
      if (!uploadExtensionPattern.test(extension)) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_UPLOAD_FILENAME',
            message: 'File must have a simple extension (letters and digits only).',
          },
        })
      }
      const fileName = part.filename
      const destination = join(targetDir, fileName)

      await mkdir(targetDir, { recursive: true })
      await pipeline(part.file, createWriteStream(destination))

      return reply.code(201).send({
        name: fileName,
        // 原始文件名与 MIME 供前端决定提示词里的引用形式（图片用 ![]()，其它用 []()）。
        originalName: part.filename,
        mimeType: part.mimetype,
        // 相对项目根的路径：CodeBuddy 服务 cwd = projectRoot，agent 可直接引用。
        relativePath: `.docs/${storyId}/${fileName}`,
        absolutePath: destination,
      })
    } catch (error) {
      return codeBuddyError(request, reply, error)
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

  /**
   * 触发构建（发布页写操作兜底）。
   * 硬规则：Harness Phase 4-6 期间站点所有发布写操作禁用；high-risk 环境必须显式解锁；
   * 不可乐观，必须等 DevOps 真实回执后才返回，并写审计。
   */
  app.post('/api/v1/devops/build', async (request, reply) => {
    const parsed = buildTriggerRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidParameters(reply)
    const input = parsed.data

    // 门控 1：Harness Phase 4-6 期间由发布助手负责，站点一律拒绝写操作
    let gatePhase: number | undefined
    try {
      const snapshot = await snapshotProvider(false)
      gatePhase = snapshot.harnessActive
        .map((active) => active.phase)
        .find((phase): phase is number => typeof phase === 'number' && phase >= 4 && phase <= 6)
    } catch (error) {
      request.log.error({ err: error }, 'Failed to read harness gate before build')
      return reply.code(502).send({
        error: { code: 'GATE_CHECK_FAILED', message: '无法确认 Harness 流程阶段，已拒绝触发构建以避免竞态。' },
      })
    }
    if (gatePhase !== undefined) {
      return reply.code(409).send({
        error: {
          code: 'HARNESS_PHASE_GATE',
          message: `Harness 正在执行 Phase ${gatePhase}，由发布助手负责；该阶段站点禁止触发构建。`,
          phase: gatePhase,
        },
      })
    }

    // 环境固定口径：分支 / build_other / env 字段均由后端映射决定，不信任前端传参
    const spec = buildEnvironmentSpecs[input.env]
    try {
      const raw = await devOps.triggerBuild({
        group: input.group,
        app: input.app,
        branch: spec.branch,
        buildOther: spec.buildOther,
        ...(spec.sendEnv ? { env: input.env } : {}),
      })
      const number = extractBuildNumber(raw)
      const result = buildTriggerResultSchema.parse({
        group: input.group,
        app: input.app,
        env: input.env,
        branch: spec.branch,
        buildOther: spec.buildOther,
        ...(number ? { number } : {}),
        ...(raw !== undefined ? { raw } : {}),
        triggeredAt: new Date().toISOString(),
      })
      await auditLog.record({
        action: 'build.trigger',
        target: `${input.group}/${input.app}`,
        reversible: false,
        result: 'succeeded',
        after: { branch: spec.branch, env: input.env, buildOther: spec.buildOther, ...(number ? { number } : {}) },
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : '触发构建失败。'
      const expiredSession = message.includes('session expired')
      await auditLog.record({
        action: 'build.trigger',
        target: `${input.group}/${input.app}`,
        reversible: false,
        result: 'failed',
        error: message,
        after: { branch: spec.branch, env: input.env, buildOther: spec.buildOther },
      }).catch(() => undefined)
      request.log.error({ channel: 'DevOps', err: error }, 'Trigger build failed')
      return reply.code(expiredSession ? 403 : 502).send({
        error: {
          code: expiredSession ? 'DEVOPS_SESSION_EXPIRED' : 'BUILD_TRIGGER_FAILED',
          message,
        },
      })
    }
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
    // refresh=1：用户手动刷新，跳过 TAPD 增强字段缓存，确保看到的是最新上游数据
    const query = z.object({ refresh: z.enum(['0', '1', 'true', 'false']).optional() }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    const snapshot = await snapshotProvider(query.data.refresh === '1' || query.data.refresh === 'true')
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

/**
 * 把快照构建包装成单飞（single-flight）：
 * 同一时刻的并发请求共享同一次构建结果，构建结束后立即复位，
 * 因此不会缓存数据、也不会让页面看到过期快照。
 * @param provider 原始快照构建函数
 * @returns 带并发去重的快照获取函数
 */
function createSingleFlight<TArgs extends unknown[], TResult>(
  provider: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  const inflight = new Map<string, Promise<TResult>>()
  return (...args: TArgs) => {
    // 参数（如是否强制刷新）不同的请求不能互相复用结果
    const key = JSON.stringify(args)
    let pending = inflight.get(key)
    if (!pending) {
      pending = provider(...args).finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    return pending
  }
}

function invalidParameters(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: { code: 'INVALID_PARAMETERS', message: 'The request parameters are invalid.' },
  })
}

/**
 * 从 DevOps 触发构建的原始响应里尽力解析构建号。
 * 响应格式不固定，解析不出时返回 undefined，不伪装成有构建号。
 * @param raw DevOps 原始响应
 * @returns 构建号字符串，或 undefined
 */
function extractBuildNumber(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const candidates = [record.number, record.build_no, record.buildNo, record.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  const data = record.data
  if (typeof data === 'object' && data !== null) return extractBuildNumber(data)
  return undefined
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
  const storyServiceSupervisor = createStoryServiceSupervisor()
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
  app.log.info(
    {
      host,
      port,
      dataDirectory: getDataDirectory(),
      storyServiceLauncher: resolveStoryServiceLauncher(),
    },
    'DevTask Console server started',
  )
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
