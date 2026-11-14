import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CronExecution, CronExecutionPage } from '@devtask/shared'
import { ScheduledTaskClient, type ExecutionQuery } from './scheduled-tasks.js'

/** 读取执行记录时的输入 */
export interface ExecutionReadOptions {
  /** 任务 ID */
  taskId: string
  /** 已解析的 CodeBuddy 实例端口；未启动服务时缺省，直接走本地文件兜底 */
  port?: number
  /** 任务所在目录（绝对路径）；用于定位本地执行记录文件 */
  taskDirectory?: string
  /** 过滤与分页条件 */
  query: ExecutionQuery
}

/** 本地执行记录文件名 */
const executionsFileName = 'scheduled_task_executions.json'
/** 本地文件最多读取的记录条数，避免超大文件拖慢请求 */
const maximumFileRecords = 200
/** 本地文件行数上限保护：超过该大小直接拒绝解析 */
const maximumFileBytes = 8 * 1024 * 1024

/**
 * 定时任务执行记录读取器。
 * 采用「API 优先、本地文件兜底」策略：实例可用时取实时数据；
 * 实例不可用或接口失败时回退解析工作区内的 scheduled_task_executions.json，
 * 并在结果里标注 source 与告警原因，绝不把离线数据当实时数据展示。
 */
export class CronExecutionReader {
  constructor(
    private readonly workspacesRoot: string,
    private readonly client: ScheduledTaskClient = new ScheduledTaskClient(),
  ) {}

  /**
   * 读取某个任务的执行记录。
   * @param options 任务标识、端口与过滤条件
   * @returns 归一后的分页结果
   */
  async read(options: ExecutionReadOptions): Promise<CronExecutionPage> {
    const limit = clampLimit(options.query.limit)
    if (options.port !== undefined) {
      try {
        const page = await this.client.listExecutions(options.port, options.taskId, { ...options.query, limit })
        return {
          executions: page.executions.map((execution) => ({
            id: execution.id,
            taskId: execution.taskId,
            status: execution.status,
            startedAt: new Date(execution.startedAt).toISOString(),
            ...(execution.completedAt !== undefined
              ? { finishedAt: new Date(execution.completedAt).toISOString() }
              : {}),
            ...(execution.runId ? { runId: execution.runId } : {}),
            ...(execution.error ? { error: execution.error } : {}),
            source: 'api' as const,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          hasMore: page.hasMore,
          source: 'api' as const,
        }
      } catch (error) {
        const fallback = await this.readFromFile(options, limit)
        return {
          ...fallback,
          warning: `实例执行记录接口不可用，已回退本地文件：${messageOf(error)}`,
        }
      }
    }
    return this.readFromFile(options, limit)
  }

  /**
   * 从本地 scheduled_task_executions.json 读取执行记录。
   * @param options 任务标识与过滤条件
   * @param limit 分页大小
   * @returns 归一后的分页结果；文件缺失时返回空列表
   */
  private async readFromFile(options: ExecutionReadOptions, limit: number): Promise<CronExecutionPage> {
    const empty: CronExecutionPage = { executions: [], hasMore: false, source: 'file' }
    if (!options.taskDirectory) return { ...empty, warning: '该任务没有可定位的工作区目录，无法读取本地执行记录。' }
    const filePath = await this.resolveFile(options.taskDirectory)
    if (!filePath) return { ...empty, warning: '本地执行记录文件不存在。' }

    let contents: string
    try {
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      return { ...empty, warning: `本地执行记录文件读取失败：${messageOf(error)}` }
    }
    if (contents.length > maximumFileBytes) {
      return { ...empty, warning: '本地执行记录文件过大，已跳过解析。' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch (error) {
      return { ...empty, warning: `本地执行记录文件不是合法 JSON：${messageOf(error)}` }
    }

    const records = normalizeFileExecutions(parsed, options.taskId)
    const filtered = records
      .filter((record) => matchesQuery(record, options.query))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    return {
      executions: filtered.slice(0, limit),
      hasMore: filtered.length > limit,
      source: 'file',
    }
  }

  /**
   * 解析并校验本地执行记录文件路径，确认它仍在工作区根目录内。
   * @param taskDirectory 任务目录绝对路径
   * @returns 文件绝对路径；路径越界或不存在时返回 undefined
   */
  private async resolveFile(taskDirectory: string): Promise<string | undefined> {
    if (!isAbsolute(taskDirectory) || !isAbsolute(this.workspacesRoot)) return undefined
    const candidate = join(taskDirectory, '.codebuddy', executionsFileName)
    try {
      const [root, file] = await Promise.all([realpath(this.workspacesRoot), realpath(candidate)])
      const fromRoot = relative(resolve(root), resolve(file))
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        return undefined
      }
      return file
    } catch {
      return undefined
    }
  }
}

/**
 * 把本地文件内容归一为执行记录数组。
 * @param value 文件解析结果，可能是数组或带外壳的对象
 * @param taskId 目标任务 ID
 * @returns 归一后的记录数组；无法识别的记录被跳过
 */
function normalizeFileExecutions(value: unknown, taskId: string): CronExecution[] {
  const candidates = extractRecords(value)
  const records: CronExecution[] = []
  for (const candidate of candidates.slice(0, maximumFileRecords)) {
    const record = toExecution(candidate, taskId)
    if (record) records.push(record)
  }
  return records
}

/**
 * 从多种可能的文件结构里取出记录数组。
 * @param value 文件解析结果
 * @returns 记录数组；无法识别时返回空数组
 */
function extractRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  if (Array.isArray(value.executions)) return value.executions
  if (Array.isArray(value.records)) return value.records
  if (isRecord(value.data)) {
    if (Array.isArray(value.data.executions)) return value.data.executions
    if (Array.isArray(value.data.records)) return value.data.records
  }
  return []
}

/**
 * 把单条本地记录归一为 CronExecution。
 * 时间字段同时兼容毫秒、秒级时间戳与 ISO 字符串；状态不认识的记录直接丢弃。
 * @param value 原始记录
 * @param taskId 目标任务 ID，用于补全缺失的 taskId 并过滤其它任务
 * @returns 归一后的记录；无法解析时返回 undefined
 */
function toExecution(value: unknown, taskId: string): CronExecution | undefined {
  if (!isRecord(value)) return undefined
  const recordTaskId = typeof value.taskId === 'string' && value.taskId ? value.taskId : taskId
  if (recordTaskId !== taskId) return undefined
  const id = typeof value.id === 'string' && value.id
    ? value.id
    : typeof value.executionId === 'string' && value.executionId
      ? value.executionId
      : undefined
  if (!id) return undefined
  const status = toStatus(value.status)
  if (!status) return undefined
  const startedAt = toIso(value.startedAt ?? value.createdAt ?? value.scheduledAt)
  if (!startedAt) return undefined
  const finishedAt = toIso(value.completedAt ?? value.finishedAt ?? value.endedAt)
  const runId = typeof value.runId === 'string' && value.runId ? value.runId : undefined
  const error = typeof value.error === 'string' && value.error ? value.error : undefined
  return {
    id,
    taskId,
    status,
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(runId ? { runId } : {}),
    ...(error ? { error } : {}),
    source: 'file',
  }
}

/**
 * 归一状态值。
 * @param value 原始状态
 * @returns 四态之一；无法识别时返回 undefined
 */
function toStatus(value: unknown): CronExecution['status'] | undefined {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed') return value
  return undefined
}

/**
 * 按状态、时间范围与关键词过滤记录。
 * @param record 记录
 * @param query 过滤条件
 * @returns 命中返回 true
 */
function matchesQuery(record: CronExecution, query: ExecutionQuery): boolean {
  if (query.status && record.status !== query.status) return false
  const startedAt = new Date(record.startedAt).getTime()
  if (query.from !== undefined && startedAt < query.from) return false
  if (query.to !== undefined && startedAt > query.to) return false
  if (query.query) {
    const needle = query.query.toLocaleLowerCase()
    const haystack = [record.id, record.runId, record.error].filter(Boolean).join(' ').toLocaleLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/**
 * 把分页大小收敛到 1–100，缺省 20。
 * @param value 原始值
 * @returns 合法的分页大小
 */
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20
  return Math.min(100, Math.max(1, Math.trunc(value)))
}

/**
 * 归一时间为 ISO UTC。
 * @param value 原始值，兼容毫秒/秒级时间戳与 ISO 字符串
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
