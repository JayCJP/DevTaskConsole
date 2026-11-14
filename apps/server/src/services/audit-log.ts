import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { auditActionSchema, type AuditAction, type AuditEntry } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/** 写入审计条目的输入 */
export interface AuditRecordInput {
  /** 动作类型 */
  action: AuditAction
  /** 动作目标标识 */
  target: string
  /** 关联 Story */
  storyId?: string
  /** 动作前状态快照 */
  before?: Record<string, unknown>
  /** 动作后状态快照 */
  after?: Record<string, unknown>
  /** 是否可撤销，缺省由动作类型推导 */
  reversible?: boolean
  /** 动作结果 */
  result?: 'succeeded' | 'failed'
  /** 失败原因摘要 */
  error?: string
}

/**
 * 可撤销动作白名单。
 * 删除任务、停止服务、删除/清理映射等动作无法通过 API 复原，永远不可撤销。
 */
const reversibleActions: readonly AuditAction[] = [
  'cron.update',
  'cron.toggle',
  'cron.owner',
]

/**
 * 判断某个动作是否属于可撤销白名单。
 * @param action 动作类型
 * @returns 可撤销返回 true
 */
export function isReversibleAction(action: AuditAction): boolean {
  return reversibleActions.includes(action)
}

/**
 * 站点操作审计流水。
 * 采用「单文件 + 原子写 + 条数上限」保存，避免无限增长；
 * 单进程串行写入，避免并发写坏 JSON。
 */
export class AuditLog {
  private readonly filePath: string
  private readonly maxEntries: number
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory(), maxEntries = 500) {
    this.filePath = join(dataDirectory, 'audit-log.json')
    this.maxEntries = Math.max(20, Math.trunc(maxEntries))
  }

  /**
   * 追加一条审计记录。
   * @param input 审计输入
   * @returns 写入后的完整条目
   */
  async record(input: AuditRecordInput): Promise<AuditEntry> {
    return this.serialize(async () => {
      const entries = await this.readAll()
      const entry: AuditEntry = {
        id: randomUUID(),
        action: input.action,
        target: input.target,
        ...(input.storyId ? { storyId: input.storyId } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(input.after ? { after: input.after } : {}),
        reversible: input.reversible ?? isReversibleAction(input.action),
        undone: false,
        result: input.result ?? 'succeeded',
        ...(input.error ? { error: input.error } : {}),
        createdAt: new Date().toISOString(),
      }
      const next = [...entries, entry].slice(-this.maxEntries)
      await this.writeAll(next)
      return entry
    })
  }

  /**
   * 读取最近的审计记录。
   * @param limit 返回条数上限，默认 100，最大 500
   * @returns 按时间倒序的条目数组
   */
  async list(limit = 100): Promise<AuditEntry[]> {
    const entries = await this.readAll()
    return [...entries].reverse().slice(0, Math.max(1, Math.min(500, limit)))
  }

  /**
   * 按 ID 查询条目。
   * @param id 审计条目 ID
   * @returns 条目；不存在时返回 undefined
   */
  async find(id: string): Promise<AuditEntry | undefined> {
    return (await this.readAll()).find((entry) => entry.id === id)
  }

  /**
   * 标记条目已撤销。
   * @param id 审计条目 ID
   * @returns 更新后的条目；不存在时返回 undefined
   */
  async markUndone(id: string): Promise<AuditEntry | undefined> {
    return this.serialize(async () => {
      const entries = await this.readAll()
      const index = entries.findIndex((entry) => entry.id === id)
      if (index < 0) return undefined
      const current = entries[index] as AuditEntry
      const updated: AuditEntry = { ...current, undone: true, undoneAt: new Date().toISOString() }
      const next = [...entries]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /**
   * 读取全部条目，并丢弃结构非法的记录。
   * @returns 审计条目数组
   */
  private async readAll(): Promise<AuditEntry[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('Audit log contains invalid JSON.', { cause: error })
    }
    if (!Array.isArray(parsed)) throw new Error('Audit log has an invalid shape.')
    return parsed.filter(isAuditEntry)
  }

  /**
   * 原子写入整份审计文件。
   * @param entries 条目数组
   * @returns Promise<void>
   */
  private async writeAll(entries: AuditEntry[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await replaceFile(temporaryPath, this.filePath)
  }

  /**
   * 串行执行读写，避免并发写坏文件。
   * @param operation 待执行操作
   * @returns 操作结果
   */
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

/**
 * 校验一条记录是否是合法审计条目。
 * @param value 原始记录
 * @returns 合法返回 true
 */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && typeof item.action === 'string'
    && auditActionSchema.safeParse(item.action).success
    && typeof item.target === 'string'
    && typeof item.reversible === 'boolean'
    && typeof item.undone === 'boolean'
    && (item.result === 'succeeded' || item.result === 'failed')
    && typeof item.createdAt === 'string'
}

/**
 * 用临时文件替换目标文件，并在 Windows 短暂占用时重试。
 * 审计文件写得最频繁，可能与本机同时运行的另一个控制台实例抢同一目标；
 * 这类 EPERM/EBUSY 通常是瞬时的，重试即可，不应当让用户的操作直接失败。
 * @param temporaryPath 临时文件路径
 * @param targetPath 目标文件路径
 * @returns Promise<void>
 */
async function replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
  const delays = [0, 20, 60]
  let lastError: unknown
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      await rename(temporaryPath, targetPath)
      return
    } catch (error) {
      lastError = error
      if (!isTemporarilyLocked(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to replace the audit log file.')
}

/**
 * 判断错误是否属于「目标文件被短暂占用」。
 * @param error 原始错误
 * @returns 可重试返回 true
 */
function isTemporarilyLocked(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES'
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
