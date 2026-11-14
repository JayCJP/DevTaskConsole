import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Cron, Requirement, WorkspaceSummary } from '@devtask/shared'
import { z } from 'zod'
import { getDataDirectory } from '../security/token-store.js'

const dateTimeSchema = z.string().datetime()

export interface CronTaskMapping {
  taskId: string
  storyId: string
  ownerSessionId: string
  mode: 'query_only' | 'query_fix'
  /** owner session 最近一次通过校验的时间；缺省表示人工录入但尚未校验 */
  ownerVerifiedAt?: string
  /** 是否因为 Story 服务被停止而由站点暂停；服务恢复后可据此自动重新启用 */
  pausedByServiceStop?: boolean
}

export class CronMappingStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'cron-mappings.json')
  }

  async list(): Promise<CronTaskMapping[]> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch (error) {
      throw new Error('Cron mapping file contains invalid JSON.', { cause: error })
    }
    if (!Array.isArray(parsed) || !parsed.every(isCronTaskMapping)) {
      throw new Error('Cron mapping file has an invalid shape.')
    }
    if (new Set(parsed.map((item) => item.taskId)).size !== parsed.length) {
      throw new Error('Cron mapping file contains duplicate task IDs.')
    }
    return parsed
  }

  async save(mapping: CronTaskMapping): Promise<void> {
    await this.serialize(async () => {
      const mappings = await this.list()
      const next = [...mappings.filter((item) => item.taskId !== mapping.taskId), mapping]
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
      await this.writeAll(next)
    })
  }

  /**
   * 查询单个任务的映射。
   * @param taskId 定时任务 ID
   * @returns 映射记录；不存在时返回 undefined
   */
  async find(taskId: string): Promise<CronTaskMapping | undefined> {
    return (await this.list()).find((mapping) => mapping.taskId === taskId)
  }

  /**
   * 局部更新映射（例如写入 owner 校验时间、标记因停服而暂停）。
   * @param taskId 定时任务 ID
   * @param patch 待合并字段
   * @returns 更新后的映射；任务不存在时返回 undefined
   */
  async update(taskId: string, patch: Partial<Omit<CronTaskMapping, 'taskId'>>): Promise<CronTaskMapping | undefined> {
    return this.serialize(async () => {
      const mappings = await this.list()
      const current = mappings.find((mapping) => mapping.taskId === taskId)
      if (!current) return undefined
      const updated: CronTaskMapping = { ...current, ...patch, taskId }
      const next = mappings
        .map((mapping) => (mapping.taskId === taskId ? updated : mapping))
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
      await this.writeAll(next)
      return updated
    })
  }

  /**
   * 删除映射（任务被删除或服务映射被清理时使用）。
   * @param taskId 定时任务 ID
   * @returns 是否确实删除了记录
   */
  async remove(taskId: string): Promise<boolean> {
    return this.serialize(async () => {
      const mappings = await this.list()
      const next = mappings.filter((mapping) => mapping.taskId !== taskId)
      if (next.length === mappings.length) return false
      await this.writeAll(next)
      return true
    })
  }

  /**
   * 原子写入整份映射文件。
   * @param mappings 完整映射列表
   * @returns Promise<void>
   */
  private async writeAll(mappings: CronTaskMapping[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(mappings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

/** 待扫描的定时任务目录：目录本身 + 可选的 Story 归属 */
interface CronSource {
  /** 目录绝对路径 */
  directory: string
  /** 目录相对工作区根目录的路径，写入 cron.workspacePath */
  relativePath: string
  /** 该目录关联的 Harness Story（来自需求的工作区路径）；工作区项目可能没有 */
  story?: Requirement
}

/**
 * 收集所有可能存放 scheduled_tasks.json 的目录。
 * 顺序：先按 Story 的工作区路径（保留 Story 归属），再补上工作区声明的项目目录，
 * 保证“工作区优先”的同时不丢失只有 Story 没有 .code-workspace 的老数据。
 * @param workspacesRoot 工作区根目录
 * @param requirements 本地 Harness 需求
 * @param workspaces 工作区扫描结果
 * @returns 去重后的目录清单（同一目录只保留带 Story 的条目）
 */
function collectSources(
  workspacesRoot: string,
  requirements: Requirement[],
  workspaces: WorkspaceSummary[],
): CronSource[] {
  const sources = new Map<string, CronSource>()

  /**
   * 登记一个候选目录，同一目录重复出现时优先保留带 Story 的条目。
   * @param directory 目录绝对路径
   * @param story 该目录关联的 Story
   */
  const register = (directory: string, story?: Requirement): void => {
    const absolute = resolve(directory)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    const existing = sources.get(key)
    if (existing) {
      if (!existing.story && story) sources.set(key, { ...existing, story })
      return
    }
    sources.set(key, {
      directory: absolute,
      relativePath: relative(workspacesRoot, absolute).replaceAll('\\', '/'),
      ...(story ? { story } : {}),
    })
  }

  for (const requirement of requirements) {
    if (!requirement.workspacePath) continue
    register(resolve(workspacesRoot, requirement.workspacePath), requirement)
  }
  for (const workspace of workspaces) {
    for (const project of workspace.projects) register(project.path)
  }
  return [...sources.values()]
}

export async function readLocalCrons(
  workspacesRoot: string,
  requirements: Requirement[],
  mappings: CronTaskMapping[],
  workspaces: WorkspaceSummary[] = [],
): Promise<{ crons: Cron[]; errors: string[] }> {
  const crons: Cron[] = []
  const errors: string[] = []
  const mappingByTask = new Map(mappings.map((mapping) => [mapping.taskId, mapping]))
  const taskIds = new Set<string>()

  for (const source of collectSources(workspacesRoot, requirements, workspaces)) {
    const label = source.story?.storyId ?? source.relativePath
    if (!isInside(workspacesRoot, source.directory)) {
      errors.push(`${label}: workspace path resolves outside the configured root.`)
      continue
    }
    const tasksPath = join(source.directory, '.codebuddy', 'scheduled_tasks.json')
    let contents: string
    try {
      const [resolvedRoot, resolvedWorkspace, resolvedTasks] = await Promise.all([
        realpath(workspacesRoot),
        realpath(source.directory),
        realpath(tasksPath),
      ])
      if (!isInside(resolvedRoot, resolvedWorkspace) || !isInside(resolvedRoot, resolvedTasks)) {
        errors.push(`${label}: scheduled task path resolves outside the configured root.`)
        continue
      }
      contents = await readFile(resolvedTasks, 'utf8')
    } catch (error) {
      if (isMissing(error)) continue
      errors.push(`${label}: unable to read scheduled_tasks.json: ${messageOf(error)}`)
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch (error) {
      errors.push(`${label}: scheduled_tasks.json is invalid JSON: ${messageOf(error)}`)
      continue
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
      errors.push(`${label}: scheduled_tasks.json must contain a tasks array.`)
      continue
    }

    for (const [index, rawTask] of parsed.tasks.entries()) {
      const task = parseTask(rawTask)
      if (!task) {
        errors.push(`${label}: scheduled task ${index + 1} has an invalid shape.`)
        continue
      }
      if (taskIds.has(task.id)) {
        errors.push(`Scheduled task ID ${task.id} appears in more than one workspace.`)
        continue
      }
      taskIds.add(task.id)

      const mapping = mappingByTask.get(task.id)
      // 同一目录已确认属于某个 Story 时，显式映射到别的 Story 视为配置冲突
      if (mapping && source.story && mapping.storyId !== source.story.storyId) {
        errors.push(`Scheduled task ${task.id} is explicitly mapped to a different Story.`)
        continue
      }
      const storyId = mapping?.storyId ?? source.story?.storyId
      const taskMode = task.mode === 'query_only' || task.mode === 'query_fix' ? task.mode : undefined
      crons.push({
        id: task.id,
        ...(storyId ? { storyId } : {}),
        ...(source.story?.title ? { storyTitle: source.story.title } : {}),
        workspacePath: source.relativePath,
        cron: task.cron,
        ...(task.enabled !== undefined ? { enabled: task.enabled } : {}),
        ...(mapping?.mode ?? taskMode ? { mode: mapping?.mode ?? taskMode } : {}),
        ...(mapping?.ownerSessionId ? { ownerSessionId: mapping.ownerSessionId } : {}),
        ...(mapping?.ownerVerifiedAt ? { ownerVerifiedAt: mapping.ownerVerifiedAt } : {}),
        ...(task.durable !== undefined ? { durable: task.durable } : {}),
        ...(task.recurring !== undefined ? { recurring: task.recurring } : {}),
        ...(task.expiryDays !== undefined ? { expiryDays: task.expiryDays } : {}),
        ...(task.nextRun ? { nextRun: task.nextRun } : {}),
        ...(task.expiresAt ? { expiresAt: task.expiresAt } : {}),
        ...(task.prompt ? { promptFirstLine: task.prompt.split(/\r?\n/, 1)[0]?.slice(0, 200) } : {}),
      })
    }
  }
  return { crons, errors }
}

interface ParsedTask {
  id: string
  cron: string
  prompt?: string
  enabled?: boolean
  mode?: string
  nextRun?: string
  expiresAt?: string
  durable?: boolean
  recurring?: boolean
  expiryDays?: number
}

function parseTask(value: unknown): ParsedTask | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.cron !== 'string'
    || !value.cron.trim()
    || (value.prompt !== undefined && typeof value.prompt !== 'string')
    || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    || (value.mode !== undefined && typeof value.mode !== 'string')
  ) return undefined
  const nextRun = normalizeDate(value.nextRun)
  const expiresAt = normalizeDate(value.expiresAt)
  // 字段存在却无法解析时视为非法任务，避免把错误配置当成“无到期时间”
  if (value.nextRun !== undefined && !nextRun) return undefined
  if (value.expiresAt !== undefined && !expiresAt) return undefined
  return {
    id: value.id,
    cron: value.cron,
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    ...(nextRun ? { nextRun } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value.durable === 'boolean' ? { durable: value.durable } : {}),
    ...(typeof value.recurring === 'boolean' ? { recurring: value.recurring } : {}),
    ...(typeof value.expiryDays === 'number' && Number.isInteger(value.expiryDays)
      ? { expiryDays: value.expiryDays }
      : {}),
  }
}

/**
 * 把定时任务的时间字段归一化为 ISO 字符串。
 * CodeBuddy 的 scheduled_tasks.json 用毫秒时间戳写 expiresAt，早期版本用 ISO 字符串，
 * 这里同时兼容毫秒与秒级时间戳，避免整条任务被判为非法。
 * @param value 原始字段值
 * @returns ISO 时间字符串；无法识别时返回 undefined
 */
function normalizeDate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    return dateTimeSchema.safeParse(trimmed).success ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1e12 ? value * 1000 : value
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

function isCronTaskMapping(value: unknown): value is CronTaskMapping {
  if (!isRecord(value)) return false
  const baseValid = typeof value.taskId === 'string'
    && value.taskId.length > 0
    && typeof value.storyId === 'string'
    && value.storyId.length > 0
    && typeof value.ownerSessionId === 'string'
    && value.ownerSessionId.length > 0
    && (value.mode === 'query_only' || value.mode === 'query_fix')
  if (!baseValid) return false
  // 新字段全部可选，保证早期仅含四个必填字段的映射文件仍可读取
  if (value.ownerVerifiedAt !== undefined && !dateTimeSchema.safeParse(value.ownerVerifiedAt).success) return false
  if (value.pausedByServiceStop !== undefined && typeof value.pausedByServiceStop !== 'boolean') return false
  return true
}

function isInside(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const fromRoot = relative(resolve(root), resolve(candidate))
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
