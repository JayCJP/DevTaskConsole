import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  REPOSITORY_CANDIDATES_CACHE_VERSION,
  repositoryCandidatesCacheSchema,
  type RepositoryCandidate,
  type RepositoryCandidatesCacheFile,
} from '@devtask/shared'
import { resolveCacheDirectory } from '../settings/cache-directory.js'

/** 候选项目缓存文件默认文件名（位于 resolveCacheDirectory() 目录下） */
const REPOSITORY_CANDIDATES_CACHE_FILENAME = 'repository-candidates-cache.json'

/**
 * 计算候选项目缓存键：源根目录路径归一化（trim + 去尾部分隔符）。
 * 不同根目录对应不同候选列表；同一目录的不同写法不会生成多份缓存。
 * @param sourceRoot 源仓库根目录
 * @returns 缓存键
 */
export function candidateCacheKey(sourceRoot: string): string {
  return sourceRoot.trim().replace(/[\\/]+$/, '')
}

/** 候选项目缓存存储接口，便于测试注入内存替身 */
export interface CandidateCacheStore {
  read(key: string): RepositoryCandidate[] | undefined
  write(key: string, candidates: RepositoryCandidate[]): Promise<void>
}

/**
 * 构造带文件缓存的候选项目 provider：普通请求命中缓存直接返回（零 readdir），
 * 未命中 / force 回源扫描并写盘。缓存不设 TTL——文件存在且合法即命中；
 * 目录结构更新完全靠 force（保存源目录配置 / 手动刷新）穿透重建。
 * 空结果不写缓存，避免把“临时扫不到”永久固化；写盘失败仅记日志降级。
 *
 * @param options.cache 缓存存储（RepositoryCandidatesCache 实例或测试替身）
 * @param options.scan 源扫描器，接收源根目录，返回候选数组
 * @param options.logError 写盘失败时的日志回调
 * @returns 带缓存的 provider，接收 sourceRoot / force
 */
export function createCachedCandidateProvider(options: {
  cache: CandidateCacheStore
  scan: (sourceRoot: string) => Promise<RepositoryCandidate[]>
  logError?: (message: string) => void
}): (sourceRoot: string, force?: boolean) => Promise<RepositoryCandidate[]> {
  return async (sourceRoot, force = false) => {
    const key = candidateCacheKey(sourceRoot)
    if (!force) {
      const hit = options.cache.read(key)
      if (hit) return hit
    }
    const candidates = await options.scan(sourceRoot)
    if (candidates.length > 0) {
      try {
        await options.cache.write(key, candidates)
      } catch (error) {
        options.logError?.(
          `Failed to write repository candidates cache: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return candidates
  }
}

/**
 * 工作区候选项目文件缓存。
 *
 * 整个候选列表按 cacheKey（源根目录）缓存在单个 JSON 文件中，命中时零 readdir。
 * 读取走同步 I/O（调用方在单飞临界区内使用），写入走串行队列 + 临时文件 + rename
 * 原子替换，沿用 board-cache.ts / snapshot-cache.ts 的写盘模式。任何缓存异常都视为未命中，
 * 绝不让坏缓存阻断候选接口。
 */
export class RepositoryCandidatesCache implements CandidateCacheStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param directory 缓存文件所在目录；默认复用可配置缓存目录，测试可注入临时目录
   */
  constructor(directory: string = resolveCacheDirectory()) {
    this.filePath = join(directory, REPOSITORY_CANDIDATES_CACHE_FILENAME)
  }

  /**
   * 读取并校验指定 key 的缓存。不设 TTL：文件存在、版本/schema 合法且含该 key 即命中；
   * 文件缺失、损坏、版本不符或 schema 非法时返回 undefined（触发回源扫描）。
   * @param key 缓存键（归一化后的源根目录）
   * @returns 命中的候选数组，或 undefined
   */
  read(key: string): RepositoryCandidate[] | undefined {
    try {
      if (!existsSync(this.filePath)) return undefined
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = repositoryCandidatesCacheSchema.safeParse(raw)
      if (!parsed.success) return undefined
      return parsed.data.entries[key]?.candidates
    } catch {
      return undefined
    }
  }

  /**
   * 写入（覆盖）指定 key 的缓存，保留文件中其它 key。
   * 写失败时原错误由调用方记日志降级；缓存是加速手段，不是真相源。
   * @param key 缓存键
   * @param candidates 要缓存的候选数组
   * @returns Promise<void>
   */
  async write(key: string, candidates: RepositoryCandidate[]): Promise<void> {
    await this.serialize(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const current = this.readAll()
      const fetchedAt = new Date().toISOString()
      const entry: RepositoryCandidatesCacheFile = {
        version: REPOSITORY_CANDIDATES_CACHE_VERSION,
        entries: {
          ...current?.entries,
          [key]: { fetchedAt, candidates },
        },
      }
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        // 清理残留临时文件，避免脏文件堆积；原错误照常抛出，由调用方记日志降级
        await rm(temporaryPath, { force: true }).catch(() => {})
        throw error
      }
    })
  }

  /**
   * 读取完整缓存文件（不做 TTL 判定），用于写入前合并其它 key。
   * 文件不存在或损坏时返回 undefined，由调用方按空缓存处理。
   * @returns 完整缓存文件结构，或 undefined
   */
  private readAll(): RepositoryCandidatesCacheFile | undefined {
    try {
      if (!existsSync(this.filePath)) return undefined
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = repositoryCandidatesCacheSchema.safeParse(raw)
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 串行化写操作，避免并发写坏同一文件。
   * @param operation 待串行执行的写操作
   * @returns 操作结果
   */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
