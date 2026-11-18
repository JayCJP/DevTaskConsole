import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BOARD_CACHE_VERSION, boardCacheSchema, type BoardCacheFile, type BoardResponse } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'
import { defaultBoardOwner } from './board.js'

/** 看板缓存文件默认文件名（位于 getDataDirectory() 目录下） */
const BOARD_CACHE_FILENAME = 'board-cache.json'

/**
 * 计算看板缓存键：`归一化owner|includeReleased`。
 * owner 先 trim、空则回落默认处理人，与 buildBoard 的归一化保持一致，避免空格产生多份缓存。
 * @param owner 处理人姓名
 * @param includeReleased 是否包含已发布需求
 * @returns 缓存键
 */
export function boardCacheKey(owner: string, includeReleased: boolean): string {
  const normalizedOwner = owner.trim() || defaultBoardOwner
  return `${normalizedOwner}|${includeReleased ? '1' : '0'}`
}

/** 看板缓存存储接口，便于测试注入内存替身 */
export interface BoardCacheStore {
  read(key: string): BoardResponse | undefined
  write(key: string, response: BoardResponse): Promise<void>
}

/**
 * 构造带文件缓存的看板 provider：普通请求命中缓存直接返回（零 MCP），未命中/force 回源并写盘。
 * 缓存不设 TTL——只要缓存文件存在且合法就一直命中；数据更新完全靠 force（手动刷新/写操作）
 * 穿透重建。TAPD 失败（ok=false）的结果不写缓存，避免把故障固化，旧缓存保留。
 *
 * @param options.cache 缓存存储（BoardCache 实例或测试替身）
 * @param options.build 看板构建器，测试可注入替身
 * @param options.logError 写盘失败时的日志回调
 * @returns 带缓存的 provider，接收 owner / includeReleased / force
 */
export function createCachedBoardProvider(options: {
  cache: BoardCacheStore
  build: (owner: string, includeReleased: boolean) => Promise<BoardResponse>
  logError?: (message: string) => void
}): (owner: string, includeReleased: boolean, force?: boolean) => Promise<BoardResponse> {
  return async (owner, includeReleased, force = false) => {
    const key = boardCacheKey(owner, includeReleased)
    if (!force) {
      const hit = options.cache.read(key)
      if (hit) return hit
    }
    const board = await options.build(owner, includeReleased)
    if (board.ok) {
      try {
        await options.cache.write(key, board)
      } catch (error) {
        options.logError?.(`Failed to write board cache: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return board
  }
}

/**
 * 看板文件缓存。
 *
 * 以「文件缓存」替代内存缓存：整个 BoardResponse 按 cacheKey（owner|includeReleased）
 * 缓存在单个 JSON 文件中，命中时零 MCP 调用。读取走同步 I/O（调用方在单飞临界区内
 * 使用，简单直接），写入走串行队列 + 临时文件 + rename 原子替换，沿用 audit-log.ts 与
 * snapshot-cache.ts 的写盘模式。任何缓存异常都视为未命中，绝不让坏缓存阻断看板接口。
 */
export class BoardCache {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param directory 缓存文件所在目录；默认复用数据目录，测试可注入临时目录
   */
  constructor(directory: string = getDataDirectory()) {
    this.filePath = join(directory, BOARD_CACHE_FILENAME)
  }

  /**
   * 读取并校验指定 key 的缓存。不设 TTL：文件存在、版本/schema 合法且含该 key 即命中；
   * 文件缺失、损坏、版本不符或 schema 非法时返回 undefined（触发回源重建）。
   * @param key 缓存键（`${normalizedOwner}|${includeReleased ? '1' : '0'}`）
   * @returns 命中的看板响应，或 undefined
   */
  read(key: string): BoardResponse | undefined {
    try {
      if (!existsSync(this.filePath)) return undefined
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = boardCacheSchema.safeParse(raw)
      if (!parsed.success) return undefined
      return parsed.data.entries[key]?.response
    } catch {
      return undefined
    }
  }

  /**
   * 写入（覆盖）指定 key 的缓存，保留文件中其它 key。
   * 写失败时原错误由调用方记日志降级；缓存是加速手段，不是真相源。
   * @param key 缓存键
   * @param response 要缓存的看板响应
   * @returns Promise<void>
   */
  async write(key: string, response: BoardResponse): Promise<void> {
    await this.serialize(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const current = this.readAll()
      const fetchedAt = response.fetchedAt ?? new Date().toISOString()
      const entry: BoardCacheFile = {
        version: BOARD_CACHE_VERSION,
        entries: {
          ...current?.entries,
          [key]: { fetchedAt, response },
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
  private readAll(): BoardCacheFile | undefined {
    try {
      if (!existsSync(this.filePath)) return undefined
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = boardCacheSchema.safeParse(raw)
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
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
