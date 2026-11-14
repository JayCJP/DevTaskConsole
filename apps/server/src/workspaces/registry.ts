import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  workspaceInitializationRequestSchema,
  type WorkspaceDeleteResult,
  type WorkspaceProject,
  type WorkspaceSummary,
} from '@devtask/shared'

const execFileAsync = promisify(execFile)

/** 与初始化学保持一致的工作区名约束（字母、数字、点、下划线、连字符） */
const workspaceNameSchema = workspaceInitializationRequestSchema.shape.workspaceName

/** 扫描工作区根目录时需要跳过的目录名 */
const ignoredDirectoryNames = new Set(['node_modules', '.git', '.codebuddy'])

/** git 命令超时时间，避免仓库异常时请求卡死 */
const gitTimeoutMs = 60_000

/** 工作区不存在 */
export class WorkspaceNotFoundError extends Error {}

/** 工作区请求参数非法（名称非法、越界路径等） */
export class WorkspaceRegistryInputError extends Error {}

interface GitMetadata {
  /** git 目录绝对路径（worktree 场景指向主仓库的 .git/worktrees/<id>） */
  gitDir: string
  /** 是否为 git worktree 检出 */
  worktree: boolean
}

/**
 * 读取目录内单条目录项的类型信息，目录不存在时返回 undefined。
 * @param path 需要检查的路径
 * @returns 目录项信息或 undefined
 */
async function statOptional(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

/**
 * 校验并解析工作区目录的绝对路径，阻止 `..` 与绝对路径逃逸出工作区根目录。
 * @param workspacesRoot 工作区根目录
 * @param name 工作区名（目录名）
 * @returns 工作区目录绝对路径
 * @throws WorkspaceRegistryInputError 名称非法或路径越界
 */
function resolveWorkspacePath(workspacesRoot: string, name: string): string {
  const parsed = workspaceNameSchema.safeParse(name)
  if (!parsed.success) {
    throw new WorkspaceRegistryInputError('工作区名只能包含字母、数字、点、下划线或连字符。')
  }
  const root = resolve(workspacesRoot)
  const target = resolve(root, name)
  const relativePath = relative(root, target)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceRegistryInputError('工作区路径必须位于工作区根目录之内。')
  }
  return target
}

/**
 * 解析项目中 `.git` 的形态，判断它是普通仓库还是 worktree 检出。
 * @param projectPath 项目目录绝对路径
 * @returns git 目录信息；不是 git 项目时返回 undefined
 */
async function readGitMetadata(projectPath: string): Promise<GitMetadata | undefined> {
  const dotGitPath = join(projectPath, '.git')
  const info = await statOptional(dotGitPath)
  if (!info) return undefined
  if (info.isDirectory()) return { gitDir: dotGitPath, worktree: false }
  if (!info.isFile()) return undefined
  try {
    const contents = await readFile(dotGitPath, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(contents)
    if (!match) return undefined
    const rawPath = match[1]!.trim()
    return {
      gitDir: isAbsolute(rawPath) ? rawPath : resolve(projectPath, rawPath),
      worktree: true,
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

/**
 * 从 git 目录的 HEAD 文件解析当前分支，不依赖 git 可执行文件（更快且无副作用）。
 * @param gitDir git 目录绝对路径
 * @returns 分支名；处于游离 HEAD 时返回短提交号；读取失败返回 undefined
 */
async function readBranch(gitDir: string): Promise<string | undefined> {
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (refMatch) return refMatch[1]
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 8)
    return undefined
  } catch {
    return undefined
  }
}

/** 工作区配置文件的扩展名 */
const workspaceFileSuffix = '.code-workspace'
/** 从扫描根目录开始查找工作区配置文件的递归深度上限 */
const maximumWorkspaceScanDepth = 3

/** `*.code-workspace` 中解析出的声明信息 */
interface WorkspaceFileDeclaration {
  /** 工作区名：取配置文件名去掉扩展名 */
  name: string
  /** folders[].path 声明的项目路径（保持原始写法，可能是相对或绝对路径） */
  folders: string[]
}

/**
 * 判断文件名是否为工作区配置文件。
 * @param fileName 目录项文件名
 * @returns 是否以 `.code-workspace` 结尾且名称为空以外的内容
 */
function isWorkspaceFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(workspaceFileSuffix) && fileName.length > workspaceFileSuffix.length
}

/**
 * 递归查找扫描根目录下的 `*.code-workspace` 文件。
 * 工作区配置文件的中心节点，一个文件代表一个工作区。
 * @param directory 当前遍历目录
 * @param depth 相对扫描根目录的深度
 * @param found 收集到的配置文件绝对路径
 * @returns Promise<void>
 */
async function collectWorkspaceFiles(directory: string, depth: number, found: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  for (const entry of entries) {
    if (entry.isFile() && isWorkspaceFile(entry.name)) {
      found.push(join(directory, entry.name))
      continue
    }
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) continue
    if (depth >= maximumWorkspaceScanDepth) continue
    await collectWorkspaceFiles(join(directory, entry.name), depth + 1, found)
  }
}

/**
 * 解析一个 `*.code-workspace` 文件，得到工作区名与其声明的项目目录。
 * @param workspaceFile 配置文件绝对路径
 * @returns 声明信息；文件缺失、JSON 非法或缺少工作区名时返回 undefined
 */
async function readWorkspaceDeclaration(workspaceFile: string): Promise<WorkspaceFileDeclaration | undefined> {
  let contents: string
  try {
    contents = await readFile(workspaceFile, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const fileName = workspaceFile.replaceAll('\\', '/').split('/').pop() ?? ''
  const name = fileName.slice(0, fileName.length - workspaceFileSuffix.length)
  if (!name) return undefined
  // VS Code 允许 folders[].path 写成相对或绝对路径，这里只做去空白与去重
  const folders = Array.isArray(parsed.folders)
    ? parsed.folders.flatMap((folder) => (
        isRecord(folder) && typeof folder.path === 'string' && folder.path.trim() ? [folder.path.trim()] : []
      ))
    : []
  return { name, folders: [...new Set(folders)] }
}

/**
 * 工作区没有声明 folders 时的兜底：把目录下带 git 元数据的子目录当作项目。
 * @param workspacePath 工作区目录
 * @returns 项目目录绝对路径数组
 */
async function scanProjectDirectories(workspacePath: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(workspacePath, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
  const projectPaths: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) continue
    const projectPath = join(workspacePath, entry.name)
    if (!(await statOptional(join(projectPath, '.git')))) continue
    projectPaths.push(projectPath)
  }
  return projectPaths
}

/**
 * 根据一个工作区配置文件生成工作区摘要。
 * @param workspacesRoot 扫描根目录（用于生成去重后的工作区名）
 * @param workspaceFile 配置文件绝对路径
 * @param usedNames 已占用的工作区名，用于处理同名配置文件
 * @returns 工作区摘要；配置文件不可解析时返回 undefined
 */
async function describeWorkspaceFile(
  workspacesRoot: string,
  workspaceFile: string,
  usedNames: Set<string>,
): Promise<WorkspaceSummary | undefined> {
  const declaration = await readWorkspaceDeclaration(workspaceFile)
  if (!declaration) return undefined
  const workspacePath = dirname(workspaceFile)
  const fileInfo = await statOptional(workspaceFile)

  let name = declaration.name
  if (usedNames.has(name)) {
    // 不同目录下的同名配置文件：用相对目录前缀保证名称唯一
    const relativeDirectory = relative(workspacesRoot, workspacePath).replaceAll('\\', '/').replaceAll('/', '-')
    name = relativeDirectory && relativeDirectory !== '.' ? `${relativeDirectory}-${declaration.name}` : name
  }
  usedNames.add(name)

  const declaredPaths = declaration.folders.map((folder) =>
    isAbsolute(folder) ? resolve(folder) : resolve(workspacePath, folder))
  const projectPaths = declaredPaths.length ? declaredPaths : await scanProjectDirectories(workspacePath)

  const projects: WorkspaceProject[] = []
  const missingProjects: string[] = []
  for (const projectPath of projectPaths) {
    const projectName = basename(projectPath)
    const projectInfo = await statOptional(projectPath)
    if (!projectInfo?.isDirectory()) {
      // 配置文件声明了但目录不存在，交给详情页提示
      missingProjects.push(projectName)
      continue
    }
    const git = await readGitMetadata(projectPath)
    if (!git) {
      projects.push({ name: projectName, path: projectPath, worktree: false })
      continue
    }
    const branch = await readBranch(git.gitDir)
    projects.push({
      name: projectName,
      path: projectPath,
      worktree: git.worktree,
      ...(branch ? { branch } : {}),
    })
  }

  return {
    name,
    path: workspacePath,
    workspaceFile,
    ...(fileInfo ? { updatedAt: fileInfo.mtime.toISOString() } : {}),
    missingProjects,
    // 保持 `folders` 声明顺序：第一个项目是流水线的锚点，不能被字母序打乱
    projects,
  }
}

/**
 * 扫描工作区根目录下的所有 `*.code-workspace`，识别工作区及其声明的项目。
 * 一个配置文件即一个工作区，项目以 `folders[].path` 为准。
 * @param workspacesRoot 工作区根目录
 * @returns 按名称排序的工作区摘要数组
 * @throws WorkspaceRegistryInputError 根目录不存在或不可访问
 */
export async function listWorkspaces(workspacesRoot: string): Promise<WorkspaceSummary[]> {
  const root = resolve(workspacesRoot)
  const rootInfo = await statOptional(root)
  if (!rootInfo?.isDirectory()) {
    throw new WorkspaceRegistryInputError(`工作区根目录不可用：${root}`)
  }
  const workspaceFiles: string[] = []
  await collectWorkspaceFiles(root, 0, workspaceFiles)
  const usedNames = new Set<string>()
  const summaries: WorkspaceSummary[] = []
  for (const workspaceFile of workspaceFiles.sort((left, right) => left.localeCompare(right))) {
    const summary = await describeWorkspaceFile(root, workspaceFile, usedNames)
    if (summary) summaries.push(summary)
  }
  return summaries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 执行一条 git 命令并返回输出，失败时抛出带 stderr 的错误。
 * @param args git 参数（不含可执行文件名）
 * @param cwd 执行目录
 * @returns 命令输出
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: gitTimeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

/**
 * 删除工作区：先逐个移除 git worktree 登记，再删除工作区目录。
 * 注意：不会删除本地分支，也不会操作远程分支。
 * @param workspacesRoot 工作区根目录
 * @param name 工作区目录名
 * @returns 删除结果，包含逐项目日志与告警
 * @throws WorkspaceNotFoundError 工作区不存在
 * @throws WorkspaceRegistryInputError 名称或路径非法
 */
export async function deleteWorkspace(workspacesRoot: string, name: string): Promise<WorkspaceDeleteResult> {
  const root = resolve(workspacesRoot)
  // 工作区名来自 *.code-workspace 文件名，目录名不一定相同，优先使用扫描结果定位
  const target = (await listWorkspaces(root)).find((summary) => summary.name === name)
  const workspacePath = target ? target.path : resolveWorkspacePath(root, name)
  const directoryInfo = await statOptional(workspacePath)
  if (!directoryInfo?.isDirectory()) {
    throw new WorkspaceNotFoundError(`工作区不存在：${name}`)
  }

  const logs: string[] = []
  const warnings: string[] = []
  const removedWorktrees: string[] = []
  const removedDirectories: string[] = []

  let entries: Dirent[] = []
  try {
    entries = await readdir(workspacePath, { withFileTypes: true })
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) continue
    const projectPath = join(workspacePath, entry.name)
    const git = await readGitMetadata(projectPath)
    if (!git) {
      removedDirectories.push(projectPath)
      logs.push(`删除普通目录：${projectPath}`)
      continue
    }
    if (!git.worktree) {
      warnings.push(`${entry.name} 不是 worktree 检出，仅删除目录，不影响源仓库。`)
      removedDirectories.push(projectPath)
      logs.push(`删除目录（非 worktree）：${projectPath}`)
      continue
    }
    // gitDir 形如 <主仓库>/.git/worktrees/<id>，向上三级即主仓库目录
    const mainRepository = resolve(git.gitDir, '..', '..', '..')
    try {
      await runGit(['-C', mainRepository, 'worktree', 'remove', '--force', projectPath], mainRepository)
      removedWorktrees.push(projectPath)
      logs.push(`已移除 worktree：${projectPath}`)
    } catch (error) {
      warnings.push(`${entry.name} 的 worktree 移除失败，改为直接删除目录：${messageOf(error)}`)
      logs.push(`worktree 移除失败，回退为目录删除：${projectPath}`)
      // 删除 worktree 目录内的 .git 链接文件后再删除目录，避免后续 git 操作命中断链
      await rm(join(projectPath, '.git'), { force: true })
      removedDirectories.push(projectPath)
    }
    // 清理主仓库中失效的 worktree 登记，避免 git worktree list 残留
    try {
      await runGit(['-C', mainRepository, 'worktree', 'prune'], mainRepository)
    } catch {
      // prune 失败不影响删除结果
    }
  }

  await rm(workspacePath, { recursive: true, force: true, maxRetries: 3 })
  logs.push(`已删除工作区目录：${workspacePath}`)
  logs.push('保留本地分支与远程分支，未执行 git push 或分支删除。')

  return {
    name,
    path: workspacePath,
    removedWorktrees,
    removedDirectories,
    logs,
    warnings,
  }
}

/**
 * 判断未知错误是否为指定 code 的 Node 异常。
 * @param error 捕获到的错误
 * @param code 目标错误码
 */
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

/**
 * 把未知错误转成可读文本。
 * @param error 捕获到的错误
 * @returns 错误信息字符串
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 判断值是否为普通对象。
 * @param value 任意值
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
