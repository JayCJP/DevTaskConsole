import type { Branch, Build, MergeRequest } from '@devtask/shared'
import type { ApplicationIdentity } from '../integrations/application-mappings.js'
import type { DevOpsAdapter } from '../integrations/devops.js'
import type { GitLabAdapter } from '../integrations/gitlab.js'

/** 工作区中参与发布链路的项目目标（来自 .code-workspace 声明的项目） */
export interface ReleaseProjectTarget {
  repoName: string
  /** 项目在 worktree 中的当前分支；缺省时无法查询 MR */
  branch?: string
  /** 使用该项目的 Harness Story */
  storyIds: string[]
}

/** MR 查询所需的 GitLab 能力；findProjects 用于按仓库名精确匹配项目 */
export type GitLabLookup = Pick<GitLabAdapter, 'listMergeRequests'>
  & Partial<Pick<GitLabAdapter, 'findProjects'>>

/** 单个仓库/应用的查询失败不影响其它仓库，失败原因单独返回 */
export interface CollectOutcome<T> {
  items: T[]
  errors: string[]
}

/**
 * 按“工作区项目 → 实际 GitLab 项目”查询目标分支为 dev 的合并请求。
 * GitLab 项目优先取人工保存的映射；缺省时只在按仓库名得到唯一精确匹配时才使用，
 * 搜索结果不落库、也不自动采用。
 * @param targets 工作区项目目标（含分支与关联 Story）
 * @param identities 仓库到外部系统身份的映射
 * @param gitlab GitLab 查询能力
 * @returns 合并请求列表与单个项目的失败原因
 */
export async function collectMergeRequests(
  targets: ReleaseProjectTarget[],
  identities: ApplicationIdentity[],
  gitlab: GitLabLookup,
): Promise<CollectOutcome<MergeRequest>> {
  const identityByRepo = new Map(identities.map((identity) => [identity.repoName, identity]))
  const resolvedProjectIds = new Map<string, number | undefined>()
  const requests = new Map<string, { projectId: number; sourceBranch: string; storyIds: Set<string> }>()

  for (const target of targets) {
    const identity = identityByRepo.get(target.repoName)
    if (!identity || !target.branch) continue
    const projectId = identity.gitlabProjectId
      ?? await resolveProjectIdByName(gitlab, target.repoName, resolvedProjectIds)
    if (projectId === undefined) continue
    const key = `${projectId}:${target.branch}`
    const request = requests.get(key) ?? { projectId, sourceBranch: target.branch, storyIds: new Set<string>() }
    for (const storyId of target.storyIds) request.storyIds.add(storyId)
    requests.set(key, request)
  }

  const errors = new Set<string>()
  const batches = await Promise.all([...requests.values()].map(async (request) => {
    try {
      const mergeRequests = await gitlab.listMergeRequests(request.projectId, request.sourceBranch)
      return mergeRequests
        .filter((mergeRequest) => mergeRequest.targetBranch === 'dev')
        .flatMap((mergeRequest) => [...request.storyIds].map((storyId) => ({ ...mergeRequest, storyId })))
    } catch (error) {
      errors.add(`GitLab 项目 ${request.projectId} 的 MR 查询失败：${messageOf(error)}`)
      return []
    }
  }))
  return { items: batches.flat(), errors: [...errors] }
}

/**
 * 查询每个 DevOps 应用最近的构建记录，按“应用 + 分组”去重。
 * 单个应用失败只记录原因，不影响其它应用。
 * @param identities 仓库到外部系统身份的映射
 * @param devops DevOps 查询能力
 * @returns 构建记录与失败原因
 */
export async function collectBuildRecords(
  identities: ApplicationIdentity[],
  devops: Pick<DevOpsAdapter, 'getBuildRecords'>,
): Promise<CollectOutcome<Build>> {
  const errors = new Set<string>()
  const batches = await Promise.all([...uniqueApplications(identities).values()].map(async ({ app, group }) => {
    try {
      return (await devops.getBuildRecords(app, 1, 20)).map((build) => ({ ...build, group }))
    } catch (error) {
      errors.add(`DevOps 应用 ${app} 的构建记录查询失败：${messageOf(error)}`)
      return []
    }
  }))
  return { items: batches.flat(), errors: [...errors] }
}

/**
 * 查询每个 DevOps 应用的分支列表，按“应用 + 分组”去重。
 * 单个应用失败只记录原因，不影响其它应用。
 * @param identities 仓库到外部系统身份的映射
 * @param devops DevOps 查询能力
 * @returns 分支列表与失败原因
 */
export async function collectBranches(
  identities: ApplicationIdentity[],
  devops: Pick<DevOpsAdapter, 'getBranches'>,
): Promise<CollectOutcome<Branch>> {
  const errors = new Set<string>()
  const batches = await Promise.all([...uniqueApplications(identities).values()].map(async ({ app, group }) => {
    try {
      return await devops.getBranches(app, group)
    } catch (error) {
      errors.add(`DevOps 应用 ${app} 的分支查询失败：${messageOf(error)}`)
      return []
    }
  }))
  return { items: batches.flat(), errors: [...errors] }
}

/**
 * 把仓库身份压缩成唯一的 DevOps 应用集合。
 * @param identities 仓库到外部系统身份的映射
 * @returns key 为 “分组:应用” 的唯一应用集合
 */
function uniqueApplications(identities: ApplicationIdentity[]): Map<string, { app: string; group: string }> {
  const unique = new Map<string, { app: string; group: string }>()
  for (const identity of identities) {
    unique.set(`${identity.devopsGroup}:${identity.devopsApp}`, {
      app: identity.devopsApp,
      group: identity.devopsGroup,
    })
  }
  return unique
}

/**
 * 按仓库名在 GitLab 中精确匹配项目 ID（同一进程内缓存结果）。
 * 只有唯一精确同名匹配才返回 ID，多个或零个匹配都视为无法确定。
 * @param gitlab GitLab 查询能力
 * @param repoName git 仓库名
 * @param cache 已解析结果缓存
 * @returns GitLab 项目 ID；无法确定时返回 undefined
 */
async function resolveProjectIdByName(
  gitlab: GitLabLookup,
  repoName: string,
  cache: Map<string, number | undefined>,
): Promise<number | undefined> {
  if (cache.has(repoName)) return cache.get(repoName)
  let projectId: number | undefined
  try {
    const projects = await gitlab.findProjects?.(repoName) ?? []
    const exact = projects.filter((project) =>
      projectNameOf(project.pathWithNamespace).toLocaleLowerCase() === repoName.toLocaleLowerCase())
    if (exact.length === 1) projectId = exact[0]?.id
  } catch {
    // 名称匹配属于便利路径，失败时按“未映射”处理，不猜测项目
    projectId = undefined
  }
  cache.set(repoName, projectId)
  return projectId
}

/**
 * 取 GitLab 项目路径中的项目名。
 * @param pathWithNamespace 形如 group/subgroup/project 的完整路径
 * @returns 最后一段项目名
 */
function projectNameOf(pathWithNamespace: string): string {
  return pathWithNamespace.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? pathWithNamespace
}

/**
 * 把未知错误转成可读文本。
 * @param error 捕获到的错误
 * @returns 错误信息
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
