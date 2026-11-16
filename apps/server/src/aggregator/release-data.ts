import type { GitLabAdapter } from '../integrations/gitlab.js'

/** MR 查询所需的 GitLab 能力；findProjects 用于按仓库名精确匹配项目 */
export type GitLabLookup = Pick<GitLabAdapter, 'listMergeRequests'>
  & Partial<Pick<GitLabAdapter, 'findProjects'>>

/**
 * 按仓库名在 GitLab 中精确匹配项目 ID（同一进程内缓存结果）。
 * 只有唯一精确同名匹配才返回 ID，多个或零个匹配都视为无法确定。
 * 除了发布链路查询，工作区创建合并请求也复用这一定位规则，保证两处选中同一个 GitLab 项目。
 * @param gitlab GitLab 查询能力
 * @param repoName git 仓库名
 * @param cache 已解析结果缓存
 * @returns GitLab 项目 ID；无法确定时返回 undefined
 */
export async function resolveProjectIdByName(
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
