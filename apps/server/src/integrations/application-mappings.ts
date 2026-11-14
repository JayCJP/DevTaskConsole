import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applicationMappingSchema, defaultDevOpsGroup, type ApplicationMapping } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

/**
 * 某个仓库在外部系统中的实际身份。
 * 默认约定：git 仓库名 == DevOps 应用名，DevOps 分组取默认分组，GitLab 项目按仓库名精确匹配；
 * 只有与默认不一致时才存在人工保存的差异映射。
 */
export interface ApplicationIdentity {
  repoName: string
  /** 人工指定的 GitLab 项目 ID；缺省表示按仓库名精确匹配 */
  gitlabProjectId?: number
  /** 实际使用的 DevOps 应用名 */
  devopsApp: string
  /** 实际使用的 DevOps 分组 */
  devopsGroup: string
  /** 是否来自人工保存的差异映射 */
  explicit: boolean
}

/**
 * 判断一条映射是否就是默认约定（名称完全一致）。
 * 这类映射无需落盘：默认约定已覆盖，只保存名称不同的人工确认结果。
 * @param mapping 待判断的映射
 * @returns 是否等价于默认身份
 */
export function isDefaultApplicationMapping(mapping: ApplicationMapping): boolean {
  return mapping.gitlabProjectId === undefined
    && mapping.devopsApp === mapping.repoName
    && mapping.devopsGroup === defaultDevOpsGroup
}

/**
 * 计算每个仓库实际生效的外部系统身份。
 * @param repoNames 需要解析的仓库名列表
 * @param mappings 人工保存的差异映射
 * @returns 仓库名到实际身份的映射（含默认身份）
 */
export function expandApplicationIdentities(
  repoNames: string[],
  mappings: ApplicationMapping[],
): ApplicationIdentity[] {
  const mappingByRepo = new Map(mappings.map((mapping) => [mapping.repoName, mapping]))
  const uniqueNames = [...new Set(repoNames)]
  return uniqueNames.map((repoName) => {
    const mapping = mappingByRepo.get(repoName)
    const devopsApp = mapping?.devopsApp ?? repoName
    const devopsGroup = mapping?.devopsGroup ?? defaultDevOpsGroup
    return {
      repoName,
      devopsApp,
      devopsGroup,
      explicit: mapping !== undefined,
      ...(mapping?.gitlabProjectId !== undefined ? { gitlabProjectId: mapping.gitlabProjectId } : {}),
    }
  })
}

/** 只保存“名称不一致”的人工映射的本地存储 */
export class ApplicationMappingStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'application-mappings.json')
  }

  /**
   * 读取全部差异映射。
   * @returns 映射数组；文件不存在时返回空数组
   */
  async list(): Promise<ApplicationMapping[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('Application mapping file contains invalid JSON.', { cause: error })
    }
    const parsed = applicationMappingSchema.array().safeParse(value)
    if (!parsed.success) throw new Error('Application mapping file has an invalid shape.', { cause: parsed.error })
    ensureUniqueRepositories(parsed.data)
    return parsed.data
  }

  /**
   * 保存一条差异映射。
   * 若提交的值与默认约定完全一致，则删除该仓库已有的差异映射（回归默认）。
   * @param input 映射内容
   * @returns 保存后的完整映射列表
   */
  async upsert(input: unknown): Promise<ApplicationMapping[]> {
    const parsed = applicationMappingSchema.safeParse(input)
    if (!parsed.success) throw new Error('Application mapping parameters are invalid.')
    const mapping = parsed.data
    return this.serialize(async () => {
      const current = await this.list()
      const remaining = current.filter((item) => item.repoName !== mapping.repoName)
      const next = (isDefaultApplicationMapping(mapping) ? remaining : [...remaining, mapping])
        .sort((left, right) => left.repoName.localeCompare(right.repoName))
      await this.write(next)
      return next
    })
  }

  /**
   * 删除某个仓库的差异映射，使其回到默认约定。
   * @param repoName git 仓库名
   * @returns 删除后的完整映射列表
   */
  async remove(repoName: string): Promise<ApplicationMapping[]> {
    return this.serialize(async () => {
      const current = await this.list()
      const next = current.filter((mapping) => mapping.repoName !== repoName)
      if (next.length !== current.length) await this.write(next)
      return next
    })
  }

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

  private async write(mappings: ApplicationMapping[]): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(mappings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }
}

/**
 * 校验映射文件中没有重复的仓库记录。
 * @param mappings 映射列表
 * @throws Error 存在重复仓库名
 */
function ensureUniqueRepositories(mappings: ApplicationMapping[]): void {
  const seen = new Set<string>()
  for (const mapping of mappings) {
    if (seen.has(mapping.repoName)) throw new Error('Application mapping file contains duplicate repository names.')
    seen.add(mapping.repoName)
  }
}
