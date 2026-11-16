import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  bugSchema,
  channelStateSchema,
  harnessActiveSchema,
  harnessBugSchema,
  openQuestionSchema,
  requirementSchema,
  workspaceSummarySchema,
} from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/** 缓存文件格式版本；结构变更时递增，读取时版本不匹配即丢弃重建 */
export const SNAPSHOT_CACHE_VERSION = 1

/**
 * 缓存文件的 zod schema。
 *
 * 必须用独立的 schema 校验缓存文件，不能用 `snapshotSchema`——后者校验的是整份快照，
 * 字段集合与缓存文件不同，直接套用会导致缓存永远校验失败（评审 P0-3）。
 */
export const snapshotCacheSchema = z.object({
  version: z.literal(SNAPSHOT_CACHE_VERSION),
  snapshotAt: z.string().datetime(),
  workspacesRoot: z.string(),
  segments: z.object({
    local: z.object({
      fetchedAt: z.string().datetime(),
      channel: channelStateSchema,
      requirements: z.array(requirementSchema),
      harnessBugs: z.array(harnessBugSchema),
      openQuestions: z.array(openQuestionSchema),
      harnessActive: z.array(harnessActiveSchema),
      workspaces: z.array(workspaceSummarySchema),
      localRootAvailable: z.boolean(),
    }),
    tapd: z.object({
      fetchedAt: z.string().datetime(),
      channel: channelStateSchema,
      /** tapdStoryId → 原始增强字段与缺陷；合并时以本地需求为骨架 */
      enrichment: z.record(z.string(), z.object({
        enrichment: z.object({
          title: z.string().optional(),
          status: z.string().optional(),
          priority: z.string().optional(),
          owner: z.string().optional(),
          iterationName: z.string().optional(),
          bugNew: z.number().int().nonnegative().optional(),
          bugReopened: z.number().int().nonnegative().optional(),
        }),
        bugs: z.array(bugSchema.omit({ storyId: true })),
      })),
    }),
  }),
})

/** 缓存文件完整结构 */
export type SnapshotCacheFile = z.infer<typeof snapshotCacheSchema>
/** 可缓存的本地扫描段 */
export type LocalSegment = SnapshotCacheFile['segments']['local']
/** 可缓存的 TAPD 段 */
export type TapdSegment = SnapshotCacheFile['segments']['tapd']

/**
 * 快照磁盘缓存。
 *
 * 只缓存「慢且稳定」的 local 扫描段与 TAPD 段；runtime、连通性与 viewer 不入缓存。
 * 读取走同步 I/O（调用方在单飞的临界区内使用，简单直接），写入走串行 + 临时文件
 * + rename 原子替换，沿用 `audit-log.ts` 的写盘模式。
 */
export class SnapshotCache {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param directory 缓存文件所在目录；默认复用数据目录，测试可注入临时目录
   */
  constructor(directory: string = getDataDirectory()) {
    this.filePath = join(directory, 'snapshot-cache.json')
  }

  /**
   * 读取并校验缓存。文件不存在、JSON 损坏、schema 校验失败或工作区根目录不匹配时返回 undefined。
   * 任何异常都视为缓存未命中——缓存是加速手段，绝不能让坏缓存阻断快照。
   *
   * @param workspacesRoot 当前工作区根目录，用于防止缓存串味
   * @returns 合法缓存条目，或 undefined
   */
  read(workspacesRoot: string): SnapshotCacheFile | undefined {
    try {
      if (!existsSync(this.filePath)) return undefined
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = snapshotCacheSchema.safeParse(raw)
      if (!parsed.success) return undefined
      if (parsed.data.workspacesRoot !== workspacesRoot) return undefined
      return parsed.data
    } catch {
      return undefined
    }
  }

  /**
   * 原子写入整份缓存文件。
   * @param entry 待写入的缓存条目
   * @returns Promise<void>
   */
  async write(entry: SnapshotCacheFile): Promise<void> {
    await this.serialize(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        // 清理残留的临时文件，避免脏文件堆积；原错误照常抛出，由调用方记日志降级
        await rm(temporaryPath, { force: true }).catch(() => {})
        throw error
      }
    })
  }

  /**
   * 串行化写操作，避免并发写坏同一文件。
   * @param operation 待串行执行的写操作
   * @returns 操作结果
   */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
