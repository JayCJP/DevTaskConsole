import type {
  WorkspaceMergeRequestCreateItem,
  WorkspaceMergeRequestCreateRequest,
  WorkspaceMergeRequestCreateResult,
  WorkspaceProject,
} from '@devtask/shared'
import { resolveProjectIdByName } from '../aggregator/release-data.js'
import {
  expandApplicationIdentities,
  type ApplicationIdentity,
  type ApplicationMappingStore,
} from '../integrations/application-mappings.js'
import type { GitLabAdapter, GitLabMergeRequest } from '../integrations/gitlab.js'
import { listWorkspaces, WorkspaceNotFoundError } from './registry.js'

/** 创建工作区合并请求所需的 GitLab 能力（按仓库名定位项目、查已有 MR、创建 MR） */
export type WorkspaceMergeRequestGitLab = Pick<
  GitLabAdapter,
  'createMergeRequest' | 'listMergeRequests' | 'findProjects'
>

/** 创建工作区合并请求的依赖，便于测试注入桩实现 */
export interface WorkspaceMergeRequestDeps {
  gitlab: WorkspaceMergeRequestGitLab
  /** 差异映射存储：仓库名与 GitLab 项目 ID 不一致时以它为准 */
  mappings: Pick<ApplicationMappingStore, 'list'>
}

/**
 * 为一个工作区批量创建合并请求。
 * 源分支固定取各项目 worktree 当前检出的分支，目标分支由调用方指定；
 * 单个项目失败只记入该项结果，不影响其它项目。
 * @param workspacesRoot 工作区根目录
 * @param workspaceName 工作区名（`*.code-workspace` 文件名）
 * @param input 目标分支与可选的项目名清单（缺省表示全部项目）
 * @param deps GitLab 与映射依赖
 * @returns 逐项目创建结果，顺序与请求的项目顺序一致
 * @throws WorkspaceNotFoundError 工作区不存在
 */
export async function createWorkspaceMergeRequests(
  workspacesRoot: string,
  workspaceName: string,
  input: WorkspaceMergeRequestCreateRequest,
  deps: WorkspaceMergeRequestDeps,
): Promise<WorkspaceMergeRequestCreateResult> {
  const workspaces = await listWorkspaces(workspacesRoot)
  const workspace = workspaces.find((item) => item.name === workspaceName)
  if (!workspace) throw new WorkspaceNotFoundError(`工作区不存在：${workspaceName}`)

  // 默认约定「仓库名 == GitLab 项目名」，只有名称不一致时才需要人工映射
  const identities = expandApplicationIdentities(
    workspace.projects.map((project) => project.name),
    await deps.mappings.list(),
  )
  const identityByRepo = new Map(identities.map((identity) => [identity.repoName, identity]))
  const projectByName = new Map(workspace.projects.map((project) => [project.name, project]))
  const requestedNames = input.projects ?? workspace.projects.map((project) => project.name)
  /** 同一仓库名在一次批量创建里只解析一次 GitLab 项目 ID */
  const projectIdCache = new Map<string, number | undefined>()

  const items = await Promise.all(requestedNames.map(async (name): Promise<WorkspaceMergeRequestCreateItem> => {
    const project = projectByName.get(name)
    if (!project) {
      return {
        project: name,
        targetBranch: input.targetBranch,
        status: 'failed',
        message: '该工作区下没有此项目。',
      }
    }
    return createProjectMergeRequest(
      workspace.name,
      project,
      input.targetBranch,
      identityByRepo.get(project.name),
      deps.gitlab,
      projectIdCache,
    )
  }))

  return { workspace: workspace.name, targetBranch: input.targetBranch, items }
}

/**
 * 为单个项目创建「当前分支 → 目标分支」的合并请求。
 * 已存在相同方向的开放 MR 时返回 exists，不重复创建。
 * @param workspaceName 工作区名，用于 MR 描述
 * @param project 工作区内的项目
 * @param targetBranch 目标分支
 * @param identity 项目的 GitLab 身份（可能缺省，缺省时按仓库名精确匹配）
 * @param gitlab GitLab 能力
 * @param projectIdCache 仓库名到 GitLab 项目 ID 的缓存
 * @returns 单项目创建结果；所有异常都转成 failed 结果，不向外抛出
 */
async function createProjectMergeRequest(
  workspaceName: string,
  project: WorkspaceProject,
  targetBranch: string,
  identity: ApplicationIdentity | undefined,
  gitlab: WorkspaceMergeRequestGitLab,
  projectIdCache: Map<string, number | undefined>,
): Promise<WorkspaceMergeRequestCreateItem> {
  const sourceBranch = project.branch
  if (!sourceBranch) {
    return failedItem(project.name, targetBranch, '读取不到项目当前分支，请确认目录是有效的 git 检出。')
  }
  if (sourceBranch === targetBranch) {
    return failedItem(project.name, targetBranch, `源分支与目标分支相同（${targetBranch}），无需创建。`, sourceBranch)
  }

  let gitlabProjectId: number | undefined
  try {
    gitlabProjectId = identity?.gitlabProjectId
      ?? await resolveProjectIdByName(gitlab, project.name, projectIdCache)
  } catch (error) {
    return failedItem(project.name, targetBranch, messageOf(error), sourceBranch)
  }
  if (gitlabProjectId === undefined) {
    return failedItem(
      project.name,
      targetBranch,
      '未能在 GitLab 中唯一定位该项目，请先在「源系统映射」里指定 GitLab 项目 ID。',
      sourceBranch,
    )
  }

  try {
    const existing = await findOpenMergeRequest(gitlab, gitlabProjectId, sourceBranch, targetBranch)
    if (existing) {
      return {
        project: project.name,
        sourceBranch,
        targetBranch,
        status: 'exists',
        gitlabProjectId,
        mergeRequestIid: existing.id,
        ...(existing.webUrl ? { webUrl: existing.webUrl } : {}),
        message: '已存在相同方向的合并请求，未重复创建。',
      }
    }

    const created = await gitlab.createMergeRequest(gitlabProjectId, {
      sourceBranch,
      targetBranch,
      title: `${project.name} ${sourceBranch} → ${targetBranch}`,
      description: `由 DevTask Console 工作区「${workspaceName}」创建，源分支为项目当前检出分支。`,
    })
    return {
      project: project.name,
      sourceBranch,
      targetBranch,
      status: 'created',
      gitlabProjectId,
      mergeRequestIid: created.id,
      ...(created.webUrl ? { webUrl: created.webUrl } : {}),
    }
  } catch (error) {
    const message = messageOf(error)
    // GitLab 对同源分支的重复 MR 返回 409，这里归一成「已存在」，避免一键创建时看到误报失败
    if (/already exists/i.test(message)) {
      return {
        project: project.name,
        sourceBranch,
        targetBranch,
        status: 'exists',
        gitlabProjectId,
        message: 'GitLab 提示该源分支到目标分支的合并请求已存在。',
      }
    }
    return {
      project: project.name,
      sourceBranch,
      targetBranch,
      status: 'failed',
      gitlabProjectId,
      message,
    }
  }
}

/**
 * 查询项目上「源分支 → 目标分支」仍处于打开状态的合并请求。
 * 查询失败不阻断创建：GitLab 会自行拒绝重复的 MR，这里只作为提前去重的便利路径。
 * @param gitlab GitLab 能力
 * @param projectId GitLab 项目 ID
 * @param sourceBranch 源分支
 * @param targetBranch 目标分支
 * @returns 命中的开放 MR；没有或查询失败时返回 undefined
 */
async function findOpenMergeRequest(
  gitlab: WorkspaceMergeRequestGitLab,
  projectId: number,
  sourceBranch: string,
  targetBranch: string,
): Promise<GitLabMergeRequest | undefined> {
  try {
    const mergeRequests = await gitlab.listMergeRequests(projectId, sourceBranch)
    return mergeRequests.find((mergeRequest) =>
      mergeRequest.state === 'opened' && mergeRequest.targetBranch === targetBranch)
  } catch {
    return undefined
  }
}

/**
 * 构造失败的项目结果。
 * @param project 项目名
 * @param targetBranch 目标分支
 * @param message 失败原因
 * @param sourceBranch 源分支（已读取到时才传）
 * @returns 状态为 failed 的结果项
 */
function failedItem(
  project: string,
  targetBranch: string,
  message: string,
  sourceBranch?: string,
): WorkspaceMergeRequestCreateItem {
  return {
    project,
    targetBranch,
    status: 'failed',
    message,
    ...(sourceBranch ? { sourceBranch } : {}),
  }
}

/**
 * 把未知错误转成可读文本。
 * @param error 捕获到的错误
 * @returns 错误信息字符串
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
