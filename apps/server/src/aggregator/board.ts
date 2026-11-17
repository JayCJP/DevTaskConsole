import { releasedStoryStatusLabels, type BoardChildStory, type BoardResponse, type BoardStory, type TapdStory, type WorkspaceBinding, type WorkspaceSummary } from '@devtask/shared'
import type { TapdParentStory } from '../integrations/tapd.js'

/** 看板默认查询的 TAPD 处理人 */
export const defaultBoardOwner = '蔡杰鹏'

/** 看板筛选选项 */
export interface BoardOptions {
  /** 是否包含“已发布”需求；默认排除 */
  includeReleased?: boolean
}

/** 状态中文名缺失时用于识别“已发布”的 TAPD 状态码（该工作区 status_9 = 已发布） */
const releasedStoryStatusCode = 'status_9'

/** 看板聚合所需的最小依赖，便于测试时注入替身 */
export interface BoardDependencies {
  /**
   * 按处理人查询 TAPD 需求。
   * `parentStories` 提供时按「父一行、子折叠」展示；缺省时降级为扁平 stories。
   */
  tapd: {
    listOwnedStories: (owner: string) => Promise<{
      stories: TapdStory[]
      parentStories?: TapdParentStory[]
      urlTemplate: string
    }>
  }
  /** 读取本地绑定关系 */
  bindings: { list: () => Promise<WorkspaceBinding[]> }
  /** 扫描本地工作区 */
  workspaces: () => Promise<WorkspaceSummary[]>
}

/** TAPD 不可用时用于兜底生成链接的模板 */
const fallbackUrlTemplate = 'https://www.tapd.cn/38260062/prong/stories/view/{id}'

/**
 * 组装看板数据：以 TAPD 需求为数据元，附加本地工作区绑定信息。
 * TAPD 请求失败时不隐藏本地手动绑定的需求，只把通道标记为不可用。
 * @param owner TAPD 处理人
 * @param dependencies 数据源依赖
 * @param options 筛选选项，默认排除“已发布”需求
 * @returns 看板响应（需求列表 + 可绑定工作区清单）
 */
export async function buildBoard(
  owner: string,
  dependencies: BoardDependencies,
  options: BoardOptions = {},
): Promise<BoardResponse> {
  const normalizedOwner = owner.trim() || defaultBoardOwner
  const includeReleased = options.includeReleased === true
  const errors: string[] = []

  let workspaces: WorkspaceSummary[] = []
  try {
    workspaces = await dependencies.workspaces()
  } catch (error) {
    errors.push(`本地工作区扫描失败：${messageOf(error)}`)
  }

  let bindings: WorkspaceBinding[] = []
  try {
    bindings = await dependencies.bindings.list()
  } catch (error) {
    errors.push(`绑定关系读取失败：${messageOf(error)}`)
  }

  let tapdStories: TapdStory[] = []
  let parentStories: TapdParentStory[] | undefined
  let urlTemplate = fallbackUrlTemplate
  let tapdOk = false
  try {
    const result = await dependencies.tapd.listOwnedStories(normalizedOwner)
    tapdStories = result.stories
    parentStories = result.parentStories
    urlTemplate = result.urlTemplate
    tapdOk = true
  } catch (error) {
    errors.push(`TAPD 需求查询失败：${messageOf(error)}`)
  }

  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const bindingByStoryId = new Map(bindings.map((binding) => [binding.tapdStoryId, binding]))

  // 父行模式：每个父需求一行，子需求折叠。已发布过滤以子需求为准：
  // 父行下只要有一个子需求未发布就显示父行；全部子都发布才隐藏。
  const rows = parentStories?.length
    ? parentStories
    : toFallbackParents(tapdStories, urlTemplate)
  // 已展示为父行/子行的 ID 不再作为「本地手动添加」的幽灵行重复出现；
  // 被「已发布」筛选隐藏的父需求，其绑定仍需在兜底列表中露出，便于解绑/查看。
  const visibleStoryIds = new Set<string>()
  let hiddenReleased = 0
  const stories: BoardStory[] = []
  for (const row of rows) {
    // 无子需求的父行按自身状态判断发布（自身即数据元）
    const releaseTargets = row.children.length ? row.children : [row]
    const visibleChildren = includeReleased
      ? row.children
      : row.children.filter((child) => !isReleasedStory(child))
    hiddenReleased += includeReleased ? 0 : releaseTargets.filter(isReleasedStory).length
    if (!includeReleased && releaseTargets.every(isReleasedStory)) continue

    const parentStory = toBoardStory(
      {
        storyId: row.storyId,
        title: row.title,
        tapdUrl: row.tapdUrl,
        ...(row.status ? { status: row.status } : {}),
        ...(row.statusLabel ? { statusLabel: row.statusLabel } : {}),
        ...(row.owner ? { owner: row.owner } : {}),
        ...(row.iterationName ? { iterationName: row.iterationName } : {}),
        ...(row.bugNew !== undefined ? { bugNew: row.bugNew } : {}),
        ...(row.bugReopened !== undefined ? { bugReopened: row.bugReopened } : {}),
      },
      undefined,
      workspaceByName,
      true,
    )
    parentStory.isParentRow = true
    const parentUrl = row.parentTapdUrl ?? row.tapdUrl
    parentStory.parentTapdUrl = parentUrl
    // 工作区绑定统一挂在父需求上：子需求不单独绑定，只展示所属父需求的信息
    parentStory.children = visibleChildren.map((child) => toBoardChild(child, parentUrl))
    visibleStoryIds.add(row.storyId)
    for (const child of visibleChildren) visibleStoryIds.add(child.storyId)
    const bound = bindingByStoryId.get(row.storyId)
    if (bound) {
      parentStory.workspaceName = bound.workspaceName
      const workspace = workspaceByName.get(bound.workspaceName)
      if (workspace) {
        parentStory.workspacePath = workspace.path
        if (workspace.workspaceFile) parentStory.workspaceFile = workspace.workspaceFile
      }
      parentStory.boundAt = bound.updatedAt
    }
    stories.push(parentStory)
  }

  // 本地手动绑定但不在当前 TAPD 结果中的需求仍需展示，避免绑定“消失”；
  // 若该需求被“已发布”筛选隐藏，则遵循筛选结果不展示。
  for (const binding of bindings) {
    if (visibleStoryIds.has(binding.tapdStoryId)) continue
    stories.push(toBoardStory(
      {
        storyId: binding.tapdStoryId,
        title: binding.storyTitle ?? binding.tapdStoryId,
        tapdUrl: binding.tapdUrl ?? urlTemplate.replace('{id}', binding.tapdStoryId),
      },
      binding,
      workspaceByName,
      false,
    ))
  }

  return {
    owner: normalizedOwner,
    fetchedAt: tapdOk ? new Date().toISOString() : null,
    // ok 只代表 TAPD 通道（数据元）是否可用；本地扫描/绑定错误通过 error 单独透出
    ok: tapdOk,
    includeReleased,
    hiddenReleased,
    ...(errors.length ? { error: errors.join(' ') } : {}),
    stories,
    workspaces,
  }
}

/**
 * 无父子信息时，把扁平需求列表降级为每个需求自身作为父行（兼容旧调用方与测试替身）。
 * @param stories 扁平 TAPD 需求
 * @param urlTemplate 详情链接模板
 * @returns 父行列表
 */
function toFallbackParents(stories: TapdStory[], urlTemplate: string): TapdParentStory[] {
  return stories.map((story) => ({
    ...story,
    children: [],
    isParentRow: true,
    parentTapdUrl: story.tapdUrl ?? urlTemplate.replace('{id}', story.storyId),
  }))
}

/**
 * 把 TAPD 子需求与绑定信息合成为看板折叠子行。
 * @param story 子需求
 * @param parentTapdUrl 所属父需求链接
 * @returns 看板子行（不含工作区绑定信息，绑定统一在父行）
 */
function toBoardChild(story: TapdStory, parentTapdUrl: string): BoardChildStory {
  return {
    storyId: story.storyId,
    parentTapdUrl,
    title: story.title,
    ...(story.status ? { status: story.status } : {}),
    ...(story.statusLabel ? { statusLabel: story.statusLabel } : {}),
    ...(story.owner ? { owner: story.owner } : {}),
    ...(story.iterationName ? { iterationName: story.iterationName } : {}),
    tapdUrl: story.tapdUrl,
    inTapdList: true,
  }
}

/**
 * 判断需求是否属于“已发布”终态。
 * 优先使用 TAPD 返回的状态中文名；中文名缺失时回退到该工作区已确认的状态码。
 * @param story TAPD 需求
 * @returns 是否为已发布需求
 */
function isReleasedStory(story: TapdStory): boolean {
  if (story.statusLabel) return releasedStoryStatusLabels.includes(story.statusLabel)
  return story.status === releasedStoryStatusCode
}

/**
 * 把 TAPD 需求与绑定关系合成看板行。
 * @param story TAPD 需求
 * @param binding 该需求对应的本地绑定（可能不存在）
 * @param workspaceByName 工作区名到工作区摘要的索引
 * @param inTapdList 是否出现在本次 TAPD 查询结果中
 * @returns 看板行
 */
function toBoardStory(
  story: TapdStory,
  binding: WorkspaceBinding | undefined,
  workspaceByName: Map<string, WorkspaceSummary>,
  inTapdList: boolean,
): BoardStory {
  const workspace = binding ? workspaceByName.get(binding.workspaceName) : undefined
  return {
    storyId: story.storyId,
    title: story.title,
    tapdUrl: story.tapdUrl,
    inTapdList,
    ...(story.status ? { status: story.status } : {}),
    ...(story.statusLabel ? { statusLabel: story.statusLabel } : {}),
    ...(story.owner ? { owner: story.owner } : {}),
    ...(story.iterationName ? { iterationName: story.iterationName } : {}),
    ...(story.bugNew !== undefined ? { bugNew: story.bugNew } : {}),
    ...(story.bugReopened !== undefined ? { bugReopened: story.bugReopened } : {}),
    ...(binding ? { workspaceName: binding.workspaceName } : {}),
    // 工作区目录被删除时仍保留绑定名，由前端提示“目录未找到”
    ...(workspace ? { workspacePath: workspace.path } : {}),
    ...(workspace?.workspaceFile ? { workspaceFile: workspace.workspaceFile } : {}),
    ...(binding ? { boundAt: binding.updatedAt } : {}),
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
