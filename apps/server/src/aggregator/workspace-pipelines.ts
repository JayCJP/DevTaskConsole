import { isAbsolute, resolve } from 'node:path'
import type {
  Cron,
  HarnessActive,
  Job,
  Requirement,
  WorkspacePipeline,
  WorkspacePipelineStory,
  WorkspaceSummary,
} from '@devtask/shared'

/** 组装工作区流水线视图所需的全部只读事实 */
export interface WorkspacePipelineInput {
  /** 工作区扫描根目录，用于把需求的工作区相对路径还原成绝对路径 */
  workspacesRoot: string
  /** 工作区扫描结果（`*.code-workspace`），是视图的唯一根 */
  workspaces: WorkspaceSummary[]
  requirements: Requirement[]
  harnessActive: HarnessActive[]
  crons: Cron[]
  jobs: Job[]
}

/** 聚合结果：按工作区组织的一对一流水线 */
export interface WorkspacePipelineResult {
  workspacePipelines: WorkspacePipeline[]
}

/**
 * 把扁平的 Story / 发布 / 定时 / 实例事实重新按「工作区 → 第一个项目 → 唯一 Story」组织。
 *
 * 识别规则只有一条：
 * 1. 锚点固定为 `*.code-workspace` 的 `folders[0]`（第一个项目）；
 * 2. Story 必须位于该项目的 `.codebuddy/plans` 下，一个工作区只认一个 Story；
 * 3. 第一个项目下出现多份 plans 时只保留一份，并在 `storyCandidates` 里暴露数量。
 *
 * @param input 工作区扫描结果与各通道事实
 * @returns 每个工作区一条流水线
 */
export function buildWorkspacePipelines(input: WorkspacePipelineInput): WorkspacePipelineResult {
  const root = resolve(input.workspacesRoot)
  const activeStoryIds = new Set(input.harnessActive.map((active) => active.storyId))
  const jobsByStory = groupByStory(input.jobs)
  const cronsByStory = groupByStory(input.crons)

  /**
   * 构造 Story 节点：挂上属于它的定时任务和实例。
   * @param requirement 被选中的需求
   * @returns 工作区流水线中的 Story 节点
   */
  const toStory = (requirement: Requirement): WorkspacePipelineStory => ({
    requirement,
    harnessActive: activeStoryIds.has(requirement.storyId),
    crons: cronsByStory.get(requirement.storyId) ?? [],
    jobs: jobsByStory.get(requirement.storyId) ?? [],
  })

  const workspacePipelines = input.workspaces.map<WorkspacePipeline>((workspace) => {
    const primary = workspace.projects[0]
    const candidates = primary
      ? input.requirements.filter((requirement) => sameDirectory(root, requirement, primary.path))
      : []
    // 多份 plans 时按 storyId 排序取第一份，保证结果稳定可复现
    const selected = [...candidates].sort((left, right) => left.storyId.localeCompare(right.storyId))[0]
    const story = selected ? toStory(selected) : undefined
    const storyId = selected?.storyId

    return {
      name: workspace.name,
      path: workspace.path,
      ...(workspace.workspaceFile ? { workspaceFile: workspace.workspaceFile } : {}),
      ...(workspace.updatedAt ? { updatedAt: workspace.updatedAt } : {}),
      missingProjects: workspace.missingProjects,
      ...(primary
        ? {
            primaryProject: {
              name: primary.name,
              path: primary.path,
              ...(primary.branch ? { branch: primary.branch } : {}),
              ...(primary.commitId ? { commitId: primary.commitId } : {}),
              worktree: primary.worktree,
            },
          }
        : {}),
      ...(story ? { story } : {}),
      storyCandidates: candidates.length,
      // 定时任务 = 该 Story 的任务 + 该项目目录下未关联 Story 的任务
      crons: primary
        ? uniqueCrons([
            ...(storyId ? cronsByStory.get(storyId) ?? [] : []),
            ...input.crons.filter((cron) =>
              !cron.storyId && normalizePath(cronDirectory(root, cron)) === normalizePath(primary.path)),
          ])
        : [],
    }
  })

  return { workspacePipelines }
}

/**
 * 判断需求目录是否就是给定项目目录（Windows 下忽略大小写与分隔符差异）。
 * @param root 工作区扫描根目录
 * @param requirement 需求
 * @param projectPath 项目目录绝对路径
 * @returns 是否同一目录
 */
function sameDirectory(root: string, requirement: Requirement, projectPath: string): boolean {
  const directory = requirementDirectory(root, requirement)
  if (!directory) return false
  return normalizePath(directory) === normalizePath(resolve(projectPath))
}

/**
 * 把需求的工作区路径还原成目录绝对路径。
 * @param root 工作区扫描根目录
 * @param requirement 需求
 * @returns 目录绝对路径；需求缺少工作区路径时返回 undefined
 */
function requirementDirectory(root: string, requirement: Requirement): string | undefined {
  if (!requirement.workspacePath) return undefined
  return isAbsolute(requirement.workspacePath)
    ? resolve(requirement.workspacePath)
    : resolve(root, requirement.workspacePath)
}

/**
 * 把定时任务的 `workspacePath`（相对工作区根）还原成目录绝对路径。
 * @param root 工作区扫描根目录
 * @param cron 定时任务
 * @returns 目录绝对路径；任务缺少路径时返回 undefined
 */
function cronDirectory(root: string, cron: Cron): string | undefined {
  if (!cron.workspacePath) return undefined
  return isAbsolute(cron.workspacePath) ? resolve(cron.workspacePath) : resolve(root, cron.workspacePath)
}

/**
 * 归一化路径：统一分隔符，Windows 下并统一小写。
 * @param path 任意路径
 * @returns 用于比较的归一化字符串
 */
function normalizePath(path: string | undefined): string | undefined {
  if (!path) return undefined
  const unified = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * 按 Story ID 对带可选 storyId 的事实分组。
 * @param items 带 storyId 的事实（定时任务 / 实例）
 * @returns Story ID 到事实数组的映射
 */
function groupByStory<T extends { storyId?: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    if (!item.storyId) continue
    grouped.set(item.storyId, [...(grouped.get(item.storyId) ?? []), item])
  }
  return grouped
}

/**
 * 定时任务按任务 ID 去重，避免 Story 归属与项目归属重复计数。
 * @param crons 定时任务列表
 * @returns 去重后的列表
 */
function uniqueCrons(crons: Cron[]): Cron[] {
  const seen = new Set<string>()
  return crons.filter((cron) => {
    if (seen.has(cron.id)) return false
    seen.add(cron.id)
    return true
  })
}
