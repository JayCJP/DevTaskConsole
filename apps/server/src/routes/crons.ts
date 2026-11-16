import type { FastifyInstance } from 'fastify'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  cronCreateRequestSchema,
  cronDispatchArchiveRequestSchema,
  cronDispatchRequestSchema,
  cronOwnerRequestSchema,
  cronUpdateRequestSchema,
  validateCronExpression,
  type Cron,
} from '@devtask/shared'
import { mergeCronFacts } from '../aggregator/cron-merge.js'
import type { CronFacts } from '../aggregator/snapshot.js'
import type { CronMappingStore } from '../aggregator/cron-data.js'
import type { AuditLog } from '../services/audit-log.js'
import type { CodeBuddyApi } from '../services/codebuddy-api.js'
import type { CronDispatchStore } from '../services/cron-dispatch.js'
import type { CronExecutionReader } from '../services/cron-executions.js'
import type { ScheduledTaskClient } from '../services/scheduled-tasks.js'
import type { StoryService, StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { RouteError, controlError, invalidParameters } from './support.js'

/** 定时任务路由依赖 */
export interface CronRouteDeps {
  /** 只读定时任务事实：不触发 TAPD/GitLab/DevOps 聚合 */
  cronFacts: () => Promise<CronFacts>
  /** 工作区根目录 */
  workspacesRoot: string
  /** Story 服务注册表：端口一律由它解析，不做全局回退 */
  supervisor: StoryServiceSupervisor
  /** CodeBuddy 定时任务客户端 */
  client: ScheduledTaskClient
  /** CodeBuddy 原始 API，用于派发轮次时创建 Job */
  api: CodeBuddyApi
  /** 执行记录读取器（API 优先、本地文件兜底） */
  executions: CronExecutionReader
  /** 本地 owner/模式映射 */
  mappings: CronMappingStore
  /** 站点派发轮次登记 */
  dispatches: CronDispatchStore
  /** 审计流水 */
  audit: AuditLog
}

/** 任务定位结果 */
interface LocatedCron {
  /** 快照中的任务事实 */
  cron: Cron
  /** 任务所在目录绝对路径；无法定位时缺省 */
  directory?: string
  /** 归属 Story */
  storyId?: string
}

const taskIdSchema = z.string().min(1).max(200)

/** 执行记录查询参数 */
const executionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  query: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
  sessionId: z.string().max(200).optional(),
})

/** 批量删除执行记录请求体 */
const deleteExecutionsSchema = z.object({
  executionIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  sessionId: z.string().max(200).optional(),
})

/**
 * 注册定时任务相关的全部写读路由。
 * @param app Fastify 实例
 * @param deps 路由依赖
 * @returns 无返回值
 */
export function registerCronRoutes(app: FastifyInstance, deps: CronRouteDeps): void {
  /**
   * 解析 Story 的可用端口。
   * 未登记服务或服务不在运行态时直接 409，不做任何端口猜测或全局回退。
   * @param storyId Story 标识
   * @returns 运行中的服务登记
   */
  const requireService = async (storyId: string): Promise<StoryService> => {
    const service = await deps.supervisor.inspect(storyId)
    if (!service) {
      throw new RouteError(
        409,
        'STORY_SERVICE_NOT_STARTED',
        `Story ${storyId} 尚未登记 CodeBuddy 服务，请先在实例页启动服务再操作定时任务。`,
      )
    }
    if (service.status !== 'running') {
      throw new RouteError(
        409,
        'STORY_SERVICE_UNAVAILABLE',
        service.error ?? `Story ${storyId} 的 CodeBuddy 服务当前不可用（状态 ${service.status}）。`,
      )
    }
    return service
  }

  /**
   * 校验 owner session 确实属于该 Story 工作区的会话列表。
   * @param service 运行中的服务
   * @param ownerSessionId 待校验的 session ID
   * @returns 校验通过返回 true
   */
  const verifyOwner = async (service: StoryService, ownerSessionId: string): Promise<void> => {
    const sessionIds = await deps.client.listSessionIds(service.port, service.cwd)
    if (!sessionIds.includes(ownerSessionId)) {
      throw new RouteError(
        409,
        'CRON_OWNER_INVALID',
        `会话 ${ownerSessionId} 不属于该 Story 工作区（共检测到 ${sessionIds.length} 个会话）。`,
      )
    }
  }

  /**
   * 在快照中定位任务，并解析其工作区目录。
   * @param taskId 任务 ID
   * @returns 定位结果
   */
  const locate = async (taskId: string): Promise<LocatedCron> => {
    // 只读本地定时任务事实：任务归属与工作区定位与 TAPD 无关
    const facts = await deps.cronFacts()
    const cron = facts.crons.find((item) => item.id === taskId)
    if (!cron) {
      throw new RouteError(404, 'CRON_TASK_NOT_FOUND', `定时任务 ${taskId} 不存在或不在任何已登记工作区中。`)
    }
    const directory = cron.workspacePath ? safeJoin(deps.workspacesRoot, cron.workspacePath) : undefined
    return { cron, ...(directory ? { directory } : {}), ...(cron.storyId ? { storyId: cron.storyId } : {}) }
  }

  /**
   * 要求任务已显式归属 Story，否则写操作无从解析端口。
   * @param located 定位结果
   * @returns 归属的 Story ID
   */
  const requireStory = (located: LocatedCron): string => {
    if (!located.storyId) {
      throw new RouteError(409, 'CRON_STORY_UNMAPPED', '该任务尚未显式归属 Story，请先保存 owner 映射。')
    }
    return located.storyId
  }

  app.get('/api/v1/crons', async (request, reply) => {
    const query = z.object({ storyId: z.string().min(1).max(200).optional() }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    try {
      // 任务列表只依赖本地文件与本地服务，不需要整份快照（也就不会顺带打 TAPD）
      const facts = await deps.cronFacts()
      const localCrons = query.data.storyId
        ? facts.crons.filter((cron) => cron.storyId === query.data.storyId)
        : facts.crons
      if (!query.data.storyId) {
        return { source: 'file', tasks: localCrons }
      }
      const service = await deps.supervisor.inspect(query.data.storyId)
      if (!service || service.status !== 'running') {
        return {
          source: 'file',
          tasks: localCrons,
          warning: '该 Story 的 CodeBuddy 服务未运行，展示的是本地任务文件中的数据。',
        }
      }
      try {
        const bound = localCrons.find((cron) => cron.ownerSessionId || cron.sessionId)
        const sessionId = await deps.client.resolveSessionId(
          service.port,
          service.cwd,
          bound?.ownerSessionId ?? bound?.sessionId,
        )
        const tasks = await deps.client.list(service.port, { sessionId })
        // 实时数据只提供运行期事实，归属与模式仍以本地文件/映射为准，否则前端会丢归属
        const workspacePath = facts.requirements.find((item) => item.storyId === query.data.storyId)?.workspacePath
        const merged = mergeCronFacts(
          localCrons,
          [
            {
              storyId: query.data.storyId,
              ...(workspacePath ? { workspacePath } : {}),
              tasks,
            },
          ],
          await deps.mappings.list(),
        )
        return { source: 'api', tasks: merged }
      } catch (error) {
        return {
          source: 'file',
          tasks: localCrons,
          warning: `任务列表接口不可用，已回退本地文件：${messageOf(error)}`,
        }
      }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/crons', async (request, reply) => {
    const body = cronCreateRequestSchema.safeParse(request.body)
    if (!body.success) return invalidParameters(reply)
    const validation = validateCronExpression(body.data.cron)
    if (!validation.ok) {
      return reply.code(400).send({ error: { code: 'CRON_EXPRESSION_INVALID', message: validation.message } })
    }
    try {
      const service = await requireService(body.data.storyId)
      const ownerSessionId = await deps.client.resolveSessionId(
        service.port,
        service.cwd,
        body.data.ownerSessionId,
      )
      const result = await deps.client.create(service.port, { ...body.data, ownerSessionId })
      const taskId = extractTaskId(result)
      const warnings: string[] = []
      if (!taskId) {
        warnings.push('上游未返回任务 ID，无法登记 owner 映射与后续派发轮次。')
      } else if (body.data.mode) {
        await deps.mappings.save({
          taskId,
          storyId: body.data.storyId,
          ownerSessionId,
          mode: body.data.mode,
          ownerVerifiedAt: new Date().toISOString(),
        })
      } else {
        warnings.push('任务已绑定 Story 实例；任务模式尚未设置，不影响启用与调度编辑。')
      }
      await deps.audit.record({
        action: 'cron.create',
        target: taskId ?? 'unknown',
        storyId: body.data.storyId,
        after: { cron: body.data.cron, mode: body.data.mode, durable: body.data.durable },
      })
      return reply.code(201).send({ taskId: taskId ?? null, ownerSessionId, result, warnings })
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.patch('/api/v1/crons/:taskId', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    const body = cronUpdateRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    if (body.data.cron !== undefined) {
      const validation = validateCronExpression(body.data.cron)
      if (!validation.ok) {
        return reply.code(400).send({ error: { code: 'CRON_EXPRESSION_INVALID', message: validation.message } })
      }
    }
    try {
      const located = await locate(params.data.taskId)
      const storyId = requireStory(located)
      const service = await requireService(storyId)
      const ownerSessionId = await deps.client.resolveSessionId(
        service.port,
        service.cwd,
        body.data.ownerSessionId ?? located.cron.ownerSessionId ?? located.cron.sessionId,
      )
      await deps.client.update(service.port, params.data.taskId, { ...body.data, ownerSessionId })
      if (body.data.ownerSessionId || body.data.mode) {
        // 映射不存在时必须新建：CronMappingStore.update 找不到记录会直接返回 undefined，
        // 只调 update 会造成「接口成功但归属没保存」的静默失败。
        const current = await deps.mappings.find(params.data.taskId)
        const nextOwnerSessionId = body.data.ownerSessionId ?? current?.ownerSessionId
        const nextMode = body.data.mode ?? current?.mode
        if (!nextOwnerSessionId || !nextMode) {
          throw new RouteError(
            409,
            'CRON_MAPPING_INCOMPLETE',
            '该任务还没有完整的 owner session 与任务模式，请在「归属设置」中一次性填写后保存。',
          )
        }
        const verifiedAt = body.data.ownerSessionId
          ? new Date().toISOString()
          : current?.ownerVerifiedAt
        await deps.mappings.save({
          taskId: params.data.taskId,
          storyId,
          ownerSessionId: nextOwnerSessionId,
          mode: nextMode,
          ...(verifiedAt ? { ownerVerifiedAt: verifiedAt } : {}),
          ...(current?.pausedByServiceStop ? { pausedByServiceStop: true } : {}),
        })
      }
      const onlyToggle = Object.keys(body.data).every((key) => key === 'enabled')
      await deps.audit.record({
        action: onlyToggle ? 'cron.toggle' : 'cron.update',
        target: params.data.taskId,
        storyId,
        before: {
          cron: located.cron.cron,
          ...(located.cron.enabled !== undefined ? { enabled: located.cron.enabled } : {}),
        },
        after: {
          ...(body.data.cron ? { cron: body.data.cron } : {}),
          ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
        },
      })
      return { updated: true }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.delete('/api/v1/crons/:taskId', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      const storyId = requireStory(located)
      const service = await requireService(storyId)
      const sessionId = await deps.client.resolveSessionId(
        service.port,
        service.cwd,
        located.cron.ownerSessionId ?? located.cron.sessionId,
      )
      await deps.client.remove(service.port, params.data.taskId, sessionId)
      await deps.mappings.remove(params.data.taskId)
      await deps.dispatches.removeByTask(params.data.taskId)
      await deps.audit.record({
        action: 'cron.delete',
        target: params.data.taskId,
        storyId,
        before: { cron: located.cron.cron },
        reversible: false,
      })
      return reply.code(204).send()
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/crons/:taskId/renew', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      const storyId = requireStory(located)
      const service = await requireService(storyId)
      const sessionId = await deps.client.resolveSessionId(
        service.port,
        service.cwd,
        located.cron.ownerSessionId ?? located.cron.sessionId,
      )
      const result = await deps.client.renew(service.port, params.data.taskId, sessionId)
      await deps.audit.record({
        action: 'cron.renew',
        target: params.data.taskId,
        storyId,
        before: located.cron.expiresAt ? { expiresAt: located.cron.expiresAt } : {},
      })
      return result ?? { renewed: true }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.get('/api/v1/crons/:taskId/executions', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    const query = executionQuerySchema.safeParse(request.query)
    if (!params.success || !query.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      const service = located.storyId ? await deps.supervisor.inspect(located.storyId) : undefined
      const port = service?.status === 'running' ? service.port : undefined
      const sessionId = service?.status === 'running'
        ? await deps.client.resolveSessionId(
            service.port,
            service.cwd,
            query.data.sessionId ?? located.cron.ownerSessionId ?? located.cron.sessionId,
          )
        : undefined
      return await deps.executions.read({
        taskId: params.data.taskId,
        ...(port !== undefined ? { port } : {}),
        ...(located.directory ? { taskDirectory: located.directory } : {}),
        query: { ...query.data, ...(sessionId ? { sessionId } : {}) },
      })
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/crons/:taskId/executions/delete', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    const body = deleteExecutionsSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      const storyId = requireStory(located)
      const service = await requireService(storyId)
      const sessionId = await deps.client.resolveSessionId(
        service.port,
        service.cwd,
        body.data.sessionId ?? located.cron.ownerSessionId ?? located.cron.sessionId,
      )
      const result = await deps.client.deleteExecutions(
        service.port,
        params.data.taskId,
        body.data.executionIds,
        sessionId,
      )
      await deps.audit.record({
        action: 'cron.executions.delete',
        target: params.data.taskId,
        storyId,
        before: { executionIds: body.data.executionIds },
        reversible: false,
      })
      return result ?? { deleted: body.data.executionIds }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.get('/api/v1/crons/dispatches', async (request, reply) => {
    const query = z.object({ taskId: z.string().min(1).max(200).optional() }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    try {
      const all = await deps.dispatches.list()
      return {
        dispatches: query.data.taskId ? all.filter((dispatch) => dispatch.taskId === query.data.taskId) : all,
      }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/crons/:taskId/dispatch', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    const body = cronDispatchRequestSchema.safeParse(request.body ?? {})
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      const storyId = requireStory(located)
      const service = await requireService(storyId)
      const mapping = await deps.mappings.find(params.data.taskId)
      const prompt = body.data.prompt ?? `/start fixbugs ${storyId}`
      // 先原子预占轮次（冲突检查与写入在同一次串行操作内完成），再调用上游创建 Job。
      // 若先检查再创建，并发请求都会建出 Job，只有其中一个能登记，另一个变成无人跟踪的孤儿 Job
      const reserved = await deps.dispatches.reserve({
        taskId: params.data.taskId,
        storyId,
        ...(mapping?.ownerSessionId ? { ownerSessionId: mapping.ownerSessionId } : {}),
        ...(body.data.label ? { label: body.data.label } : {}),
      })
      let job
      try {
        job = await createJob(deps, service, {
          prompt,
          name: `定时任务派发 · ${located.cron.storyTitle ?? storyId}`,
        })
      } catch (error) {
        // 上游未创建成功：把预占的轮次归档，避免这条任务被占住而无法重试
        await deps.dispatches.archive(reserved.roundId, 'failed')
        throw error
      }
      // 上游已建 Job 但未返回 ID 时轮次照常保留，由用户在 CodeBuddy 侧确认后再归档
      let dispatch = reserved
      if (job.id) {
        dispatch = (await deps.dispatches.attachJob(reserved.roundId, job.id)) ?? reserved
      }
      await deps.audit.record({
        action: 'cron.dispatch',
        target: params.data.taskId,
        storyId,
        after: { roundId: dispatch.roundId, jobId: dispatch.jobId },
        reversible: false,
      })
      return reply.code(201).send(dispatch)
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/crons/:taskId/dispatches/:roundId/archive', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema, roundId: z.string().min(1).max(200) }).safeParse(request.params)
    const body = cronDispatchArchiveRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      // 先校验归属再落盘：archive() 一旦执行就写入文件，若先写后校验会把别的任务的轮次误归档
      const dispatches = await deps.dispatches.list()
      const target = dispatches.find((dispatch) => dispatch.roundId === params.data.roundId)
      if (!target || target.taskId !== params.data.taskId) {
        throw new RouteError(404, 'CRON_DISPATCH_NOT_FOUND', '派发轮次不存在或不属于该任务。')
      }
      if (target.state !== 'open') {
        throw new RouteError(
          409,
          'CRON_DISPATCH_ALREADY_ARCHIVED',
          `轮次 ${target.roundId} 已于 ${target.updatedAt} 归档，无需重复归档。`,
        )
      }
      const archived = await deps.dispatches.archive(params.data.roundId, body.data.outcome)
      if (!archived) throw new RouteError(404, 'CRON_DISPATCH_NOT_FOUND', '派发轮次不存在。')
      await deps.audit.record({
        action: 'cron.dispatch.archive',
        target: params.data.taskId,
        storyId: archived.storyId,
        before: { roundId: archived.roundId, state: 'open' },
        after: { outcome: archived.outcome },
        reversible: false,
      })
      return archived
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.put('/api/v1/crons/:taskId/mapping', async (request, reply) => {
    const params = z.object({ taskId: taskIdSchema }).safeParse(request.params)
    const body = cronOwnerRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const located = await locate(params.data.taskId)
      if (located.cron.storyId && located.cron.storyId !== body.data.storyId) {
        throw new RouteError(404, 'CRON_TASK_NOT_FOUND', '该任务不属于所选的 Story。')
      }
      const shouldVerify = body.data.verify !== false
      let verifiedAt: string | undefined
      if (shouldVerify) {
        const service = await requireService(body.data.storyId)
        await verifyOwner(service, body.data.ownerSessionId)
        await deps.client.update(service.port, params.data.taskId, { ownerSessionId: body.data.ownerSessionId })
        verifiedAt = new Date().toISOString()
      }
      const previous = await deps.mappings.find(params.data.taskId)
      const mapping = {
        taskId: params.data.taskId,
        storyId: body.data.storyId,
        ownerSessionId: body.data.ownerSessionId,
        mode: body.data.mode,
        ...(verifiedAt ? { ownerVerifiedAt: verifiedAt } : {}),
        ...(previous?.pausedByServiceStop ? { pausedByServiceStop: previous.pausedByServiceStop } : {}),
      }
      await deps.mappings.save(mapping)
      await deps.audit.record({
        action: 'cron.owner',
        target: params.data.taskId,
        storyId: body.data.storyId,
        before: previous
          ? { ownerSessionId: previous.ownerSessionId, mode: previous.mode }
          : {},
        after: { ownerSessionId: mapping.ownerSessionId, mode: mapping.mode },
      })
      return mapping
    } catch (error) {
      return controlError(request, reply, error)
    }
  })
}

/**
 * 通过 CodeBuddy jobs 接口创建独立的 StoryRound Job。
 * 与实例页创建 Job 使用同一接口，但由站点侧显式发起，便于登记轮次。
 * @param deps 路由依赖
 * @param service 运行中的服务
 * @param body Job 名称与提示词
 * @returns Job 标识与 session 标识；上游未返回时字段缺省
 */
async function createJob(
  deps: CronRouteDeps,
  service: StoryService,
  body: { prompt: string; name: string },
): Promise<{ id?: string; sessionId?: string }> {
  const result = await deps.api.request(service.port, '/api/v1/jobs', 'POST', {
    prompt: body.prompt,
    name: body.name,
    cwd: service.cwd,
  })
  if (typeof result !== 'object' || result === null) return {}
  const record = result as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : undefined
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
  return { ...(id ? { id } : {}), ...(sessionId ? { sessionId } : {}) }
}

/**
 * 把相对工作区路径解析为绝对路径，越界时返回 undefined。
 * @param root 工作区根目录
 * @param relativePath 相对路径
 * @returns 绝对路径；越界或非法时返回 undefined
 */
function safeJoin(root: string, relativePath: string): string | undefined {
  const absolute = resolve(root, relativePath)
  if (!isAbsolute(absolute)) return undefined
  const fromRoot = relative(resolve(root), absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    return undefined
  }
  return absolute
}

/**
 * 从创建任务的响应中提取任务 ID。
 * @param payload 上游响应
 * @returns 任务 ID；无法识别时返回 undefined
 */
function extractTaskId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.id === 'string') return record.id
  if (typeof record.taskId === 'string') return record.taskId
  const task = record.task
  if (typeof task === 'object' && task !== null && typeof (task as Record<string, unknown>).id === 'string') {
    return (task as Record<string, unknown>).id as string
  }
  const data = record.data
  if (typeof data === 'object' && data !== null) return extractTaskId(data)
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
