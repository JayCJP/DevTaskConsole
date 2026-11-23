import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RepositoryCandidate {
  name: string
  path: string
}

export function getSourceRoot(): string {
  if (process.env.DEVTASK_SOURCE_ROOT) return process.env.DEVTASK_SOURCE_ROOT
  return process.platform === 'win32' ? 'D:\\workfile' : join(homedir(), 'devtask-repositories')
}

/**
 * 解析源仓库根目录，优先级：持久化配置 > 环境变量 > 默认值。
 * 配置为空字符串视为“未设置”，回退到环境变量/默认值。
 * 保持 async 是为了读取配置（由调用方传入已读取的对象），不改动同步的 getSourceRoot。
 * @param settings 控制台配置（devtaskSourceRoot 可缺省）
 * @returns 生效的源仓库根目录
 */
export async function resolveSourceRoot(settings?: {
  devtaskSourceRoot?: string
}): Promise<string> {
  const configured = settings?.devtaskSourceRoot?.trim()
  if (configured) return configured
  return getSourceRoot()
}

/**
 * 列出源根目录下所有含 .git 的子目录作为工作区候选项目。
 * 显式传入 sourceRoot 时直接使用（兼容初始化校验与测试）；否则按配置/环境变量/默认值解析。
 * @param sourceRoot 显式指定的源根目录，缺省时从 settings 解析
 * @param settings 控制台配置（用于解析源根目录）
 * @returns 按名称排序的候选项目数组
 */
export async function listRepositoryCandidates(
  sourceRoot?: string,
  settings?: { devtaskSourceRoot?: string },
): Promise<RepositoryCandidate[]> {
  const root = sourceRoot ?? (await resolveSourceRoot(settings))
  const entries = await readdir(root, { withFileTypes: true })
  const candidates: RepositoryCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const repositoryPath = join(root, entry.name)
    try {
      await access(join(repositoryPath, '.git'))
      candidates.push({ name: entry.name, path: repositoryPath })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
