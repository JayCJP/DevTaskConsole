import { z } from 'zod'
import { cronExecutionStatusSchema, type CronCreateRequest, type CronUpdateRequest } from '@devtask/shared'
import { CodeBuddyApi, CodeBuddyApiError } from './codebuddy-api.js'

/**
 * CodeBuddy 侧的定时任务事实。
 * 字段名与 `scheduled_tasks.json` 基本一致，但接口在不同版本里可能用 `cron` 或 `schedule`，
 * 因此解析时两者都接受，统一收敛成 `cron`。
 */
export interface RemoteScheduledTask {
  /** 定时任务 ID */
  id: string
  /** 5 字段 cron 表达式 */
  cron: string
  /** 定时执行的 prompt 原文 */
  prompt?: string
  /** 是否启用 */
  enabled?: boolean
  /** 是否循环执行 */
  recurring?: boolean
  /** 是否跨 session 持久化 */
  durable?: boolean
  /** 所属 session */
  sessionId?: string
  /** Agent Home 智能体 ID */
  agentId?: string
  /** 下次运行时间（ISO UTC） */
  nextRun?: string
  /** 到期时间（ISO UTC） */
  expiresAt?: string
  /** 有效期天数；null 表示永不过期 */
  expiryDays?: number | null
}

/** 执行记录查询条件 */
export interface ExecutionQuery {
  /** 按状态过滤 */
  status?: 'queued' | 'running' | 'succeeded' | 'failed'
  /** 开始时间下界（毫秒时间戳） */
  from?: number
  /** 开始时间上界（毫秒时间戳） */
  to?: number
  /** 关键词，匹配执行 ID、提示词、错误或调度表达式 */
  query?: string
  /** 上一页返回的游标 */
  cursor?: string
  /** 分页大小，1–100 */
  limit?: number
  /** 额外透传的 session ID */
  sessionId?: string
}

/** 执行记录分页结果 */
export interface RemoteExecutionPage {
  executions: RemoteExecution[]
  nextCursor?: string
  hasMore: boolean
}

/** CodeBuddy 执行记录原始形状（归一前的子集） */
export interface RemoteExecution {
  id: string
  taskId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  /** 开始时间（毫秒时间戳） */
  startedAt: number
  /** 结束时间（毫秒时间戳） */
  completedAt?: number
  runId?: string
  error?: string
  sessionId?: string
}

const executionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  status: cronExecutionStatusSchema,
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  error: z.string().optional(),
  sessionId: z.string().optional(),
})

/**
 * CodeBuddy 定时任务 API 的薄封装。
 * 只负责路径拼接、查询参数编码与响应形状校验，端口由调用方（Story 服务注册表）解析后注入。
 */
export class ScheduledTaskClient {
  constructor(private readonly api: CodeBuddyApi = new CodeBuddyApi()) {}

  /**
   * 列出定时任务。
   * @param port CodeBuddy 实例端口
   * @param query 可选的 session 过滤条件
   * @returns 归一后的任务数组；响应无法识别任务数组时抛 502
   */
  async list(port: number, query: { sessionId?: string } = {}): Promise<RemoteScheduledTask[]> {
    const search = new URLSearchParams()
    if (query.sessionId) search.set('sessionId', query.sessionId)
    const path = `/api/v1/scheduled-tasks${search.size ? `?${search}` : ''}`
    const payload = await this.api.request(port, path, 'GET')
    const tasks = extractArray(payload, ['tasks', 'scheduledTasks'])
    if (!tasks) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid scheduled task list.')
    return tasks.map((task) => toRemoteTask(task))
  }

  /**
   * 创建定时任务。
   * @param port CodeBuddy 实例端口
   * @param body 创建参数，含 cron、prompt 及可选的持久化字段
   * @returns 上游原始响应，交由路由层原样返回
   */
  async create(port: number, body: CronCreateRequest): Promise<unknown> {
    const payload: Record<string, unknown> = {
      cron: body.cron,
      prompt: body.prompt,
    }
    if (body.recurring !== undefined) payload.recurring = body.recurring
    if (body.durable !== undefined) payload.durable = body.durable
    if (body.expiryDays !== undefined) payload.expiryDays = body.expiryDays
    if (body.ownerSessionId) payload.sessionId = body.ownerSessionId
    return this.api.request(port, '/api/v1/scheduled-tasks', 'POST', payload)
  }

  /**
   * 更新定时任务（含启用/暂停）。
   * @param port CodeBuddy 实例端口
   * @param taskId 定时任务 ID
   * @param body 待更新字段
   * @returns 上游原始响应
   */
  async update(port: number, taskId: string, body: CronUpdateRequest): Promise<unknown> {
    const payload: Record<string, unknown> = {}
    if (body.cron !== undefined) payload.cron = body.cron
    if (body.prompt !== undefined) payload.prompt = body.prompt
    if (body.recurring !== undefined) payload.recurring = body.recurring
    if (body.durable !== undefined) payload.durable = body.durable
    if (body.enabled !== undefined) payload.enabled = body.enabled
    if (body.expiryDays !== undefined) payload.expiryDays = body.expiryDays
    if (body.ownerSessionId) payload.sessionId = body.ownerSessionId
    return this.api.request(port, `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}`, 'PATCH', payload)
  }

  /**
   * 删除定时任务。
   * @param port CodeBuddy 实例端口
   * @param taskId 定时任务 ID
   * @param sessionId 可选的 session 限定
   * @returns 无返回值；上游失败时抛错
   */
  async remove(port: number, taskId: string, sessionId?: string): Promise<void> {
    const search = new URLSearchParams()
    if (sessionId) search.set('sessionId', sessionId)
    const path = `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}${search.size ? `?${search}` : ''}`
    await this.api.request(port, path, 'DELETE')
  }

  /**
   * 续期持久化任务；续期不会解除手动暂停。
   * @param port CodeBuddy 实例端口
   * @param taskId 定时任务 ID
   * @param sessionId 可选的 session 限定
   * @returns 上游返回的续期后任务
   */
  async renew(port: number, taskId: string, sessionId?: string): Promise<unknown> {
    const search = new URLSearchParams()
    if (sessionId) search.set('sessionId', sessionId)
    const path = `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/renew${search.size ? `?${search}` : ''}`
    return this.api.request(port, path, 'POST')
  }

  /**
   * 查询执行记录。
   * @param port CodeBuddy 实例端口
   * @param taskId 定时任务 ID
   * @param query 过滤与分页条件
   * @returns 归一后的执行记录分页结果
   */
  async listExecutions(port: number, taskId: string, query: ExecutionQuery = {}): Promise<RemoteExecutionPage> {
    const search = new URLSearchParams()
    if (query.sessionId) search.set('sessionId', query.sessionId)
    if (query.status) search.set('status', query.status)
    if (query.from !== undefined) search.set('from', String(query.from))
    if (query.to !== undefined) search.set('to', String(query.to))
    if (query.query) search.set('query', query.query)
    if (query.cursor) search.set('cursor', query.cursor)
    if (query.limit !== undefined) search.set('limit', String(query.limit))
    const path = `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/executions${search.size ? `?${search}` : ''}`
    const payload = await this.api.request(port, path, 'GET')
    return parseExecutionPage(payload)
  }

  /**
   * 批量删除已完成的执行记录。
   * @param port CodeBuddy 实例端口
   * @param taskId 定时任务 ID
   * @param executionIds 待删除的执行记录 ID（1–100 个）
   * @param sessionId 可选的 session 限定
   * @returns 上游返回的删除结果
   */
  async deleteExecutions(
    port: number,
    taskId: string,
    executionIds: string[],
    sessionId?: string,
  ): Promise<unknown> {
    return this.api.request(
      port,
      `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/executions/delete`,
      'POST',
      { executionIds, ...(sessionId ? { sessionId } : {}) },
    )
  }

  /**
   * 列出实例上的会话，用于校验 owner session 是否属于该 Story 工作区。
   * @param port CodeBuddy 实例端口
   * @param cwd 该 Story 的工作目录
   * @returns 会话 ID 数组
   */
  async listSessionIds(port: number, cwd: string): Promise<string[]> {
    const search = new URLSearchParams({ cwd })
    const payload = await this.api.request(port, `/api/v1/sessions?${search}`, 'GET')
    const container = extractRecord(payload, 'data') ?? payload
    const sessions = isRecord(container) ? container.sessions : undefined
    if (!Array.isArray(sessions)) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid session list.')
    return sessions
      .map((session) => (isRecord(session) && typeof session.id === 'string' ? session.id : undefined))
      .filter((id): id is string => id !== undefined)
  }
}

/**
 * 从各种可能的响应外壳中取出任务数组。
 * 支持裸数组与 `{ data: [...] }`、`{ data: { tasks } }`、`{ tasks }` 等形式。
 * @param payload 上游响应
 * @param keys 候选的数组字段名
 * @returns 数组；无法识别时返回 undefined
 */
function extractArray(payload: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(payload)) return payload
  const data = isRecord(payload) ? payload.data : undefined
  if (Array.isArray(data)) return data
  for (const container of [data, payload]) {
    if (!isRecord(container)) continue
    for (const key of keys) {
      const value = container[key]
      if (Array.isArray(value)) return value
    }
  }
  return undefined
}

/**
 * 取出响应外壳中的对象。
 * @param payload 上游响应
 * @param key 字段名
 * @returns 对象；不存在时返回 undefined
 */
function extractRecord(payload: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload[key]
  return isRecord(value) ? value : undefined
}

/**
 * 把上游任务对象归一为 RemoteScheduledTask。
 * cron 字段兼容 `cron` 与 `schedule` 两种命名；时间字段兼容毫秒与 ISO 字符串。
 * @param value 上游任务对象
 * @returns 归一后的任务；缺少必要字段时抛 502
 */
function toRemoteTask(value: unknown): RemoteScheduledTask {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new CodeBuddyApiError(502, 'CodeBuddy returned a scheduled task without a valid ID.')
  }
  const cron = typeof value.cron === 'string' ? value.cron : typeof value.schedule === 'string' ? value.schedule : undefined
  if (!cron) throw new CodeBuddyApiError(502, `Scheduled task ${value.id} has no cron expression.`)
  const nextRun = toIso(value.nextRun)
  const expiresAt = toIso(value.expiresAt)
  return {
    id: value.id,
    cron,
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.recurring === 'boolean' ? { recurring: value.recurring } : {}),
    ...(typeof value.durable === 'boolean' ? { durable: value.durable } : {}),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(nextRun ? { nextRun } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value.expiryDays === 'number' || value.expiryDays === null
      ? { expiryDays: value.expiryDays as number | null }
      : {}),
  }
}

/**
 * 解析执行记录分页响应。
 * @param payload 上游响应
 * @returns 归一后的分页结果；形状非法时抛 502
 */
function parseExecutionPage(payload: unknown): RemoteExecutionPage {
  const container = extractRecord(payload, 'data') ?? (isRecord(payload) ? payload : undefined)
  if (!container) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid execution list.')
  const rawExecutions = container.executions
  if (!Array.isArray(rawExecutions)) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid execution list.')
  const executions: RemoteExecution[] = []
  for (const raw of rawExecutions) {
    const parsed = executionSchema.safeParse(raw)
    // 单条记录形状异常不应让整个列表失败，跳过并在前端表现为缺一条记录
    if (parsed.success) executions.push(parsed.data)
  }
  const nextCursor = typeof container.nextCursor === 'string' ? container.nextCursor : undefined
  return {
    executions,
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: container.hasMore === true,
  }
}

/**
 * 把毫秒时间戳或 ISO 字符串归一成 ISO UTC。
 * @param value 原始值
 * @returns ISO 字符串；无法解析时返回 undefined
 */
function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
