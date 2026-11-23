import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  consoleSettingsFileSchema,
  type ConsoleSettings,
  type ConsoleSettingsFile,
} from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/** 控制台配置文件名（位于 getDataDirectory() 目录下） */
const SETTINGS_FILENAME = 'console-settings.json'

/**
 * 控制台可编辑配置的本地持久化。
 *
 * 配置文件固定留在数据目录（可由 DEVTASK_DATA_DIR 自举覆盖），不随 cacheDirectory 迁移，
 * 避免“要先读配置才知道配置在哪”的自举死锁。配置读取端（源根目录 / 缓存目录 / TAPD 处理人）
 * 在每次相关请求时读取，保存后下一次请求自然生效。
 */
export class SettingsStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param dataDirectory 数据目录，默认使用控制台私有目录；测试可注入临时目录
   */
  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, SETTINGS_FILENAME)
  }

  /**
   * 异步读取配置。文件不存在时返回空对象；非法 JSON 或结构不符时抛错。
   * @returns 解析后的完整配置
   * @throws Error 文件内容不是合法 JSON 或结构不符合约定
   */
  async get(): Promise<ConsoleSettingsFile> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return {}
      throw error
    }
    return parseSettings(contents)
  }

  /**
   * 同步读取配置，供服务启动阶段构造缓存实例等同步路径使用。
   * 任何异常（文件缺失 / 损坏）都按“未配置”处理，返回空对象，绝不阻断启动。
   * @returns 解析后的完整配置，或空对象
   */
  getSync(): ConsoleSettingsFile {
    try {
      if (!existsSync(this.filePath)) return {}
      return parseSettings(readFileSync(this.filePath, 'utf8'))
    } catch {
      return {}
    }
  }

  /**
   * 合并更新配置：只覆盖 patch 中出现的字段，空字符串原样保留（由读取端判为未设置）。
   * 读写经串行队列，避免并发 PUT 互相覆盖。
   * @param patch 要更新的字段（部分配置）
   * @returns 写入后的完整配置
   */
  async update(patch: ConsoleSettings): Promise<ConsoleSettingsFile> {
    return this.serialize(async () => {
      const current = await this.get()
      // 用 passthrough schema 合并：保留未知字段，避免旧版本抹掉新版本配置
      const merged = consoleSettingsFileSchema.parse({ ...current, ...patch })
      await this.write(merged)
      return merged
    })
  }

  /**
   * 串行化写操作，避免并发请求互相覆盖文件。
   * @param operation 待执行的写操作
   * @returns 操作结果
   */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /**
   * 原子写入配置文件（先写临时文件再重命名）。
   * @param settings 完整配置
   * @returns Promise<void>
   */
  private async write(settings: ConsoleSettingsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }
}

/**
 * 解析配置文本：先 JSON.parse 再 zod 校验。
 * @param contents 配置文件文本
 * @returns 解析后的完整配置
 * @throws Error 非法 JSON 或结构不符合约定
 */
function parseSettings(contents: string): ConsoleSettingsFile {
  let value: unknown
  try {
    value = JSON.parse(contents) as unknown
  } catch (error) {
    throw new Error('配置文件包含非法 JSON。', { cause: error })
  }
  const parsed = consoleSettingsFileSchema.safeParse(value)
  if (!parsed.success) throw new Error('配置文件结构非法。', { cause: parsed.error })
  return parsed.data
}

/**
 * 判断错误是否为文件不存在。
 * @param error 捕获到的错误
 * @returns 是否为 ENOENT
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
