import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workspaceBindingSchema, type WorkspaceBinding } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/** 目标工作区已被其他 TAPD 需求占用 */
export class WorkspaceBindingConflictError extends Error {}

/** 绑定参数非法 */
export class WorkspaceBindingInputError extends Error {}

/**
 * 把 TAPD 需求链接或纯 ID 归一化为需求 ID。
 * 支持 `https://www.tapd.cn/38260062/prong/stories/view/1138260062001031810` 这类链接。
 * @param value 用户输入的 TAPD 链接或需求 ID
 * @returns 纯数字需求 ID
 * @throws WorkspaceBindingInputError 无法提取需求 ID
 */
export function normalizeTapdStoryId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new WorkspaceBindingInputError('TAPD 需求 ID 不能为空。')
  if (/^\d{1,32}$/.test(trimmed)) return trimmed
  // 链接形态：取路径中最后一段数字
  const match = /(\d{6,32})\/?(?:[?#].*)?$/.exec(trimmed)
  if (match?.[1]) return match[1]
  throw new WorkspaceBindingInputError('无法从输入中识别 TAPD 需求 ID，请粘贴需求链接或纯数字 ID。')
}

/**
 * 工作区 ↔ TAPD 需求绑定关系的本地持久化。
 * 约束：一个工作区只绑定一个需求，一个需求只绑定一个工作区。
 */
export class WorkspaceBindingStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param dataDirectory 本地数据目录，默认使用控制台的私有数据目录
   */
  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'workspace-bindings.json')
  }

  /**
   * 读取全部绑定关系。
   * @returns 绑定关系数组；文件不存在时返回空数组
   * @throws Error 文件内容不是合法 JSON 或结构不符合约定
   */
  async list(): Promise<WorkspaceBinding[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('绑定关系文件包含非法 JSON。', { cause: error })
    }
    const parsed = workspaceBindingSchema.array().safeParse(value)
    if (!parsed.success) throw new Error('绑定关系文件结构非法。', { cause: parsed.error })
    ensureUnique(parsed.data)
    return parsed.data
  }

  /**
   * 新增或更新一条绑定关系。
   * 同一需求重复保存视为编辑；同一工作区被其他需求占用时拒绝写入。
   * @param input 绑定内容（updatedAt 由本方法补齐）
   * @returns 写入后的完整绑定列表
   * @throws WorkspaceBindingConflictError 工作区已被其他需求占用
   */
  async upsert(input: Omit<WorkspaceBinding, 'updatedAt'> & { updatedAt?: string }): Promise<WorkspaceBinding[]> {
    const parsed = workspaceBindingSchema.safeParse({
      ...input,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    })
    if (!parsed.success) throw new WorkspaceBindingInputError('绑定参数非法。')
    const next = parsed.data
    return this.serialize(async () => {
      const current = await this.list()
      const workspaceOwner = current.find(
        (binding) => binding.workspaceName === next.workspaceName && binding.tapdStoryId !== next.tapdStoryId,
      )
      if (workspaceOwner) {
        throw new WorkspaceBindingConflictError(
          `工作区 ${next.workspaceName} 已绑定需求 ${workspaceOwner.tapdStoryId}，请先解绑。`,
        )
      }
      const merged = [
        ...current.filter((binding) => binding.tapdStoryId !== next.tapdStoryId),
        next,
      ].sort((left, right) => left.tapdStoryId.localeCompare(right.tapdStoryId))
      await this.write(merged)
      return merged
    })
  }

  /**
   * 解除某个 TAPD 需求的绑定。
   * @param tapdStoryId TAPD 需求 ID
   * @returns 删除后的完整绑定列表
   */
  async remove(tapdStoryId: string): Promise<WorkspaceBinding[]> {
    return this.serialize(async () => {
      const current = await this.list()
      const merged = current.filter((binding) => binding.tapdStoryId !== tapdStoryId)
      if (merged.length !== current.length) await this.write(merged)
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
    this.queue = new Promise((resolve) => {
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
   * 原子写入绑定文件（先写临时文件再重命名）。
   * @param bindings 完整绑定列表
   * @returns Promise<void>
   */
  private async write(bindings: WorkspaceBinding[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(bindings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }
}

/**
 * 校验绑定文件中没有一对多的重复记录。
 * @param bindings 绑定列表
 * @throws Error 存在重复的需求 ID 或工作区名
 */
function ensureUnique(bindings: WorkspaceBinding[]): void {
  const storyIds = new Set<string>()
  const workspaceNames = new Set<string>()
  for (const binding of bindings) {
    if (storyIds.has(binding.tapdStoryId)) throw new Error('绑定关系文件存在重复的 TAPD 需求 ID。')
    if (workspaceNames.has(binding.workspaceName)) throw new Error('绑定关系文件存在重复的工作区名。')
    storyIds.add(binding.tapdStoryId)
    workspaceNames.add(binding.workspaceName)
  }
}

/**
 * 判断错误是否为文件不存在。
 * @param error 捕获到的错误
 * @returns 是否为 ENOENT
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
