import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cronDispatchSchema, type CronDispatch } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/** 同一任务已存在未归档轮次时抛出，用于阻断重复派发 */
export class CronDispatchConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronDispatchConflictError'
  }
}

/** 创建轮次登记的输入 */
export interface CronDispatchInput {
  /** 定时任务 ID */
  taskId: string
  /** 关联 Story */
  storyId: string
  /** 派发使用的 owner session */
  ownerSessionId?: string
  /** CodeBuddy 返回的 Job ID */
  jobId?: string
  /** 轮次备注 */
  label?: string
}

/**
 * 站点自有的定时任务派发轮次登记表。
 * CodeBuddy 的 cron 能力本身不提供「终态归档 / 同 Story 新轮次」语义，
 * 因此这里只维护站点登记的轮次：同一任务存在 open 轮次时禁止重复派发，
 * 归档后允许开启新轮次。所有判断都基于本站记录，不臆造上游状态。
 */
export class CronDispatchStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'cron-dispatches.json')
  }

  /**
   * 列出全部轮次登记。
   * @returns 轮次数组
   */
  async list(): Promise<CronDispatch[]> {
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
      throw new Error('Cron dispatch registry contains invalid JSON.', { cause: error })
    }
    const result = cronDispatchSchema.array().safeParse(parsed)
    if (!result.success) throw new Error('Cron dispatch registry has an invalid shape.')
    return result.data
  }

  /**
   * 查询某任务当前未归档的轮次。
   * @param taskId 定时任务 ID
   * @returns 未归档轮次；不存在时返回 undefined
   */
  async openFor(taskId: string): Promise<CronDispatch | undefined> {
    return (await this.list()).find((dispatch) => dispatch.taskId === taskId && dispatch.state === 'open')
  }

  /**
   * 登记一次新派发。
   * @param input 派发信息
   * @returns 新建的轮次
   */
  async create(input: CronDispatchInput): Promise<CronDispatch> {
    return this.serialize(async () => {
      const dispatches = await this.list()
      const open = dispatches.find((dispatch) => dispatch.taskId === input.taskId && dispatch.state === 'open')
      if (open) {
        throw new CronDispatchConflictError(
          `定时任务 ${input.taskId} 还有未归档的轮次 ${open.roundId}，请先归档再派发新一轮。`,
        )
      }
      const now = new Date().toISOString()
      const dispatch: CronDispatch = {
        roundId: randomUUID(),
        taskId: input.taskId,
        storyId: input.storyId,
        ...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.label ? { label: input.label } : {}),
        state: 'open',
        createdAt: now,
        updatedAt: now,
      }
      await this.writeAll([...dispatches, dispatch])
      return dispatch
    })
  }

  /**
   * 归档一个轮次。
   * @param roundId 轮次 ID
   * @param outcome 终态
   * @returns 归档后的轮次；不存在时返回 undefined
   */
  async archive(roundId: string, outcome: CronDispatch['outcome']): Promise<CronDispatch | undefined> {
    return this.serialize(async () => {
      if (!outcome) return undefined
      const dispatches = await this.list()
      const index = dispatches.findIndex((dispatch) => dispatch.roundId === roundId)
      if (index < 0) return undefined
      const updated: CronDispatch = {
        ...(dispatches[index] as CronDispatch),
        state: 'archived',
        outcome,
        updatedAt: new Date().toISOString(),
      }
      const next = [...dispatches]
      next[index] = updated
      await this.writeAll(next)
      return updated
    })
  }

  /**
   * 删除某任务的全部轮次登记（任务被删除时清理）。
   * @param taskId 定时任务 ID
   * @returns 删除的条数
   */
  async removeByTask(taskId: string): Promise<number> {
    return this.serialize(async () => {
      const dispatches = await this.list()
      const next = dispatches.filter((dispatch) => dispatch.taskId !== taskId)
      if (next.length === dispatches.length) return 0
      await this.writeAll(next)
      return dispatches.length - next.length
    })
  }

  /**
   * 原子写入整份登记文件。
   * @param dispatches 轮次数组
   * @returns Promise<void>
   */
  private async writeAll(dispatches: CronDispatch[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(dispatches, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }

  /**
   * 串行执行读写。
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
