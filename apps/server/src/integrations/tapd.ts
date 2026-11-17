import { defaultTapdWorkspaceId, type Bug, type Requirement, type TapdStory } from '@devtask/shared'
import { McpConnectError, mcpClientRegistry, type McpClientRegistry } from './mcp-client.js'

const requiredReadTools = ['get_stories_or_tasks', 'get_related_bugs', 'get_bug', 'get_iterations']
type ToolListing = Awaited<ReturnType<McpClientRegistry['listTools']>>
type ToolResult = Awaited<ReturnType<McpClientRegistry['callTool']>>
const tapdWorkspaceId = defaultTapdWorkspaceId
const storyFields = 'id,name,status,priority_label,owner,iteration_id,iteration_name'
/**
 * 按处理人列需求时额外需要的字段：
 * - created：创建时间
 * - parent_id / ancestor_id / children_id：父子关系，用于把子需求聚合到父需求行
 */
const ownedStoryFields = `${storyFields},created,parent_id,ancestor_id,children_id`
/** TAPD 未返回 url_template 时使用的需求详情链接模板 */
const defaultStoryUrlTemplate = 'https://www.tapd.cn/38260062/prong/stories/view/{id}'
const bugFields = 'id,title,status,current_owner,created,module,description'

/** TAPD 需求增强字段的缓存时长：60 秒内的重复快照复用上次结果，手动刷新可穿透 */
const enrichmentTtlMs = 60_000

/** `aggregate()` 的返回结果 */
export interface TapdAggregateResult {
  requirements: Requirement[]
  bugs: Bug[]
  /** 本次结果中最早一条缓存的时间（ISO 时间字符串）；全部来自实时请求时缺省 */
  cachedAt?: string
}

/** TAPD 侧返回、可缓存到需求上的增强字段 */
export interface StoryEnrichment {
  title?: string
  status?: string
  priority?: string
  owner?: string
  iterationName?: string
  bugNew?: number
  bugReopened?: number
}

/** 单个 TAPD Story 的原始缓存条目：增强字段 + 关联缺陷（缺陷不含 storyId） */
export interface TapdStoryCacheEntry {
  enrichment: StoryEnrichment
  bugs: Array<Omit<Bug, 'storyId'>>
}

/**
 * 看板父子需求行：父需求一行，折叠其子需求。
 * tapdUrl 指向父需求；bugNew/bugReopened 为父+子范围内关联到看板 owner 的缺陷数。
 */
export interface TapdParentStory extends TapdStory {
  /** 折叠在其下的子需求（自身为父、无子时为空数组） */
  children: TapdStory[]
  /** 父行/子行标识 */
  isParentRow: boolean
  /** 父需求详情链接（父行指向自身） */
  parentTapdUrl: string
  /** 关联到看板 owner 的新增/重开缺陷数（父子汇总去重） */
  bugNew?: number
  bugReopened?: number
}

interface RelatedBug {
  bugId: string
  storyId?: string
}

/**
 * 用 TAPD 原始增强字段合并本地需求骨架，并派生关联缺陷。
 *
 * 始终以传入的本地需求为骨架，只对带 `tapdStoryId` 的需求叠加 TAPD 字段，
 * 因此本地新增/删除需求立即生效，不会被旧的 TAPD 数组覆盖。
 * 该函数是纯函数——`aggregate()` 与快照磁盘缓存命中时的重组共用同一套合并语义。
 *
 * @param requirements 本地需求骨架
 * @param enrichment tapdStoryId → 原始增强字段与缺陷
 * @returns 增强后的需求与关联缺陷
 */
export function mergeTapdEnrichment(
  requirements: Requirement[],
  enrichment: ReadonlyMap<string, TapdStoryCacheEntry>,
): { requirements: Requirement[]; bugs: Bug[] } {
  const bugs: Bug[] = []
  const seenBugs = new Set<string>()
  const enrichedRequirements = requirements.map((requirement) => {
    const tapdStoryId = requirement.tapdStoryId
    if (!tapdStoryId) return requirement
    const cached = enrichment.get(tapdStoryId)
    if (!cached) return { ...requirement, tapdWorkspaceId }
    for (const bug of cached.bugs) {
      const key = `${requirement.storyId}:${bug.id}`
      if (seenBugs.has(key)) continue
      seenBugs.add(key)
      bugs.push({ ...bug, storyId: requirement.storyId })
    }
    return { ...requirement, tapdWorkspaceId, ...cached.enrichment }
  })
  return { requirements: enrichedRequirements, bugs }
}

interface StoryDetails {
  storyId: string
  iterationId?: string
  title?: string
  status?: string
  priority?: string
  owner?: string
  iterationName?: string
}

export class TapdAdapter {
  /** TAPD 需求状态码到中文名的映射缓存，避免每次查询需求都重复拉取 */
  private storyStatusLabels?: Promise<Map<string, string>>
  /**
   * 需求增强字段的按 Story 缓存。
   *
   * 只缓存 TAPD 侧返回的字段（标题/状态/负责人/迭代/缺陷数与其缺陷明细），
   * 合并时仍以调用方传入的当前本地需求为骨架，因此本地新增或删除需求会立即生效，
   * 不会出现「本地改了却被旧数组覆盖」的不同步。
   */
  private readonly enrichmentCache = new Map<string, {
    at: number
    enrichment: StoryEnrichment
    bugs: Array<Omit<Bug, 'storyId'>>
  }>()

  constructor(
    private readonly tools: Pick<McpClientRegistry, 'listTools' | 'callTool'> = mcpClientRegistry,
  ) {}

  async checkConnection(): Promise<boolean> {
    let listing: ToolListing
    try {
      listing = await this.tools.listTools('TAPD_MCP_Server')
    } catch (error) {
      const code = safeErrorCode(error)
      const codeDetail = code ? ` (${code})` : ''
      // 只透出 MCP 客户端已脱敏的启动错误（含 429 限流、子进程输出等），避免转发未净化的原始错误
      const reason = error instanceof McpConnectError ? describeError(error) : ''
      throw new Error(
        `TAPD MCP connection failed${codeDetail}${reason ? `: ${reason}` : ''}. `
        + 'Check its local command and configuration.',
        { cause: error },
      )
    }
    if (!listing) return false
    const available = new Set(listing.tools.map((tool) => tool.name))
    const missing = requiredReadTools.filter((name) => !available.has(name))
    if (missing.length) {
      throw new Error(`TAPD MCP is missing required read-only tools: ${missing.join(', ')}.`)
    }
    return true
  }

  /**
   * 用 TAPD 数据增强本地需求，并返回按 Story 关联的缺陷。
   *
   * TAPD 侧字段按 Story 缓存 60 秒（`options.force` 可强制穿透），
   * 合并时始终以传入的本地需求为骨架，因此本地改动立刻生效。
   *
   * @param requirements 当前本地 Harness 需求
   * @param options.force 是否忽略缓存重新拉取 TAPD
   * @returns 增强后的需求与匹配到的缺陷
   */
  async aggregate(
    requirements: Requirement[],
    options: { force?: boolean } = {},
  ): Promise<TapdAggregateResult> {
    const mappedRequirements = requirements.filter(
      (requirement): requirement is Requirement & { tapdStoryId: string } =>
        typeof requirement.tapdStoryId === 'string' && requirement.tapdStoryId.trim().length > 0,
    )
    if (!mappedRequirements.length) return { requirements, bugs: [] }
    const storyIds = [...new Set(mappedRequirements.map((requirement) => requirement.tapdStoryId))]
    const harnessStoriesByTapdId = new Map<string, string>()
    for (const requirement of mappedRequirements) {
      const harnessStoryId = harnessStoriesByTapdId.get(requirement.tapdStoryId)
      if (harnessStoryId && harnessStoryId !== requirement.storyId) {
        throw new Error(`TAPD Story ${requirement.tapdStoryId} maps to multiple Harness Stories.`)
      }
      harnessStoriesByTapdId.set(requirement.tapdStoryId, requirement.storyId)
    }

    const now = Date.now()
    const staleStoryIds = storyIds.filter((storyId) =>
      options.force === true || !this.isEnrichmentFresh(storyId, now))
    if (staleStoryIds.length) {
      const fetched = await this.fetchEnrichment(staleStoryIds)
      for (const [storyId, entry] of fetched) {
        this.enrichmentCache.set(storyId, { at: now, ...entry })
      }
    }

    // 从内存缓存取出原始增强字段，统一走纯函数合并——与快照缓存命中时的重组共用同一套语义
    const raw = this.exportRawEnrichment(storyIds)
    const merged = mergeTapdEnrichment(requirements, raw)
    const cacheTimes: number[] = []
    // 本次刚拉取过的 ID 不算“复用缓存”，否则会把新鲜数据误标成 stale
    const fetchedStoryIds = new Set(staleStoryIds)
    for (const storyId of raw.keys()) {
      if (!fetchedStoryIds.has(storyId)) {
        const entry = this.enrichmentCache.get(storyId)
        if (entry) cacheTimes.push(entry.at)
      }
    }
    return {
      requirements: merged.requirements,
      bugs: merged.bugs,
      // 有任一需求复用了缓存，就按最早的那次时间标注
      ...(cacheTimes.length ? { cachedAt: new Date(Math.min(...cacheTimes)).toISOString() } : {}),
    }
  }

  /**
   * 导出指定 Story 的 TAPD 原始增强字段（不含 `at`），供快照磁盘缓存持久化。
   * 只导出当前内存缓存中确实存在的条目；未缓存的请求 ID 会被忽略。
   *
   * @param storyIds 需要导出的 TAPD Story ID 列表
   * @returns tapdStoryId → 原始增强字段与缺陷
   */
  exportRawEnrichment(storyIds: string[]): Map<string, TapdStoryCacheEntry> {
    const result = new Map<string, TapdStoryCacheEntry>()
    for (const storyId of storyIds) {
      const cached = this.enrichmentCache.get(storyId)
      if (cached) result.set(storyId, { enrichment: cached.enrichment, bugs: cached.bugs })
    }
    return result
  }

  /**
   * 判断某个 TAPD 需求的增强字段缓存是否仍然有效。
   * @param storyId TAPD 需求 ID
   * @param now 当前时间戳
   * @returns 是否在 TTL 内
   */
  private isEnrichmentFresh(storyId: string, now: number): boolean {
    const cached = this.enrichmentCache.get(storyId)
    return cached !== undefined && now - cached.at < enrichmentTtlMs
  }

  /**
   * 从 TAPD 拉取指定需求的增强字段与关联缺陷。
   * @param storyIds 需要拉取的 TAPD 需求 ID
   * @returns 需求 ID 到增强字段和缺陷明细的映射
   */
  private async fetchEnrichment(
    storyIds: string[],
  ): Promise<Map<string, { enrichment: StoryEnrichment; bugs: Array<Omit<Bug, 'storyId'>> }>> {
    const [storiesResponse, relatedResponse] = await Promise.all([
      this.callJsonTool('get_stories_or_tasks', {
        workspace_id: tapdWorkspaceId,
        options: {
          entity_type: 'stories',
          id: storyIds.join(','),
          limit: 200,
          fields: storyFields,
        },
      }),
      this.callJsonTool('get_related_bugs', {
        workspace_id: tapdWorkspaceId,
        options: { story_id: storyIds.join(',') },
      }),
    ])
    const stories = parseStories(storiesResponse)
    const returnedStoryIds = new Set(stories.map((story) => story.storyId))
    const missingStoryIds = storyIds.filter((storyId) => !returnedStoryIds.has(storyId))
    if (missingStoryIds.length) {
      throw new Error(`TAPD did not return requested Stories: ${missingStoryIds.join(', ')}.`)
    }
    const relatedBugs = parseRelatedBugs(relatedResponse, storyIds)
    const iterationIds = [...new Set(stories.flatMap((story) =>
      story.iterationId && !story.iterationName ? [story.iterationId] : []))]
    if (iterationIds.length) {
      const iterations = parseIterations(await this.callJsonTool('get_iterations', {
        workspace_id: tapdWorkspaceId,
        options: { id: iterationIds.join(','), limit: 200, fields: 'id,name' },
      }))
      const iterationNames = new Map(iterations.map((iteration) => [iteration.id, iteration.name]))
      for (const story of stories) {
        if (!story.iterationName && story.iterationId) {
          story.iterationName = iterationNames.get(story.iterationId)
        }
      }
    }
    const bugIds = [...new Set(relatedBugs.map((bug) => bug.bugId))]
    const bugs = bugIds.length
      ? parseBugResponse(await this.callJsonTool('get_bug', {
          workspace_id: tapdWorkspaceId,
          options: {
            id: bugIds.join(','),
            status: 'new|reopened',
            limit: 200,
            fields: bugFields,
          },
        }), new Set(bugIds))
      : []

    const storyById = new Map(stories.map((story) => [story.storyId, story]))
    const relatedByStory = new Map<string, Set<string>>()
    for (const related of relatedBugs) {
      if (!related.storyId) continue
      const bugIdsForStory = relatedByStory.get(related.storyId) ?? new Set<string>()
      bugIdsForStory.add(related.bugId)
      relatedByStory.set(related.storyId, bugIdsForStory)
    }
    const bugsById = new Map(bugs.map((bug) => [bug.id, bug]))

    const result = new Map<string, { enrichment: StoryEnrichment; bugs: Array<Omit<Bug, 'storyId'>> }>()
    for (const storyId of storyIds) {
      const story = storyById.get(storyId)
      const bugIdsForStory = relatedByStory.get(storyId)
      const matchingBugs = bugIds.length
        ? bugs.filter((bug) =>
            bugIdsForStory?.has(bug.id) === true && hasOwnerMatch(bug.currentOwner, story?.owner))
        : []
      result.set(storyId, {
        enrichment: {
          ...(story?.title ? { title: story.title } : {}),
          ...(story?.status ? { status: story.status } : {}),
          ...(story?.priority ? { priority: story.priority } : {}),
          ...(story?.owner ? { owner: story.owner } : {}),
          ...(story?.iterationName ? { iterationName: story.iterationName } : {}),
          ...(story?.owner
            ? {
                bugNew: matchingBugs.filter((bug) => bug.status === 'new').length,
                bugReopened: matchingBugs.filter((bug) => bug.status === 'reopened').length,
              }
            : {}),
        },
        bugs: matchingBugs.flatMap((bug) => {
          const detail = bugsById.get(bug.id)
          return detail
            ? [{
                id: detail.id,
                status: detail.status,
                currentOwner: detail.currentOwner,
                ...(detail.title ? { title: detail.title } : {}),
                ...(detail.created ? { created: detail.created } : {}),
                ...(detail.module ? { module: detail.module } : {}),
                ...(detail.description ? { description: detail.description } : {}),
              }]
            : []
        }),
      })
    }
    return result
  }

  async enrichRequirements(requirements: Requirement[]): Promise<Requirement[]> {
    return (await this.aggregate(requirements)).requirements
  }

  /**
   * 按处理人查询 TAPD 需求，作为看板的数据元。
   * 只读查询，不按标题或仓库名做本地猜测。
   *
   * 除扁平子需求列表（`stories`）外，额外返回按父需求聚合的 `parentStories`：
   * 每个父需求一行（tapdUrl 指向父），子需求折叠在 `children` 中，
   * 且父行汇总其「父 + 全部子」范围内关联到当前处理人本人的新增/重开缺陷数。
   * 批量取父、父子聚合失败时降级为「每个子需求自身即父行」，不阻断看板。
   *
   * @param owner TAPD 处理人姓名，例如“蔡杰鹏”
   * @returns 扁平需求列表、父子聚合列表与 TAPD 详情链接模板
   * @throws Error 处理人为空、MCP 未配置或响应结构非法
   */
  async listOwnedStories(owner: string): Promise<{
    stories: TapdStory[]
    /** 父子聚合行；未提供时看板降级为扁平 stories */
    parentStories?: TapdParentStory[]
    urlTemplate: string
  }> {
    const normalizedOwner = owner.trim()
    if (!normalizedOwner) throw new Error('TAPD 处理人不能为空。')
    const value = await this.callJsonTool('get_stories_or_tasks', {
      workspace_id: tapdWorkspaceId,
      options: {
        entity_type: 'stories',
        owner: normalizedOwner,
        limit: 200,
        fields: ownedStoryFields,
      },
    })
    const rows = getDataRows(value, 'get_stories_or_tasks')
    const urlTemplate = readUrlTemplate(value) ?? defaultStoryUrlTemplate
    const statusLabels = await this.loadStoryStatusLabels()
    const { stories, parentIds } = rows.reduce<{
      stories: Array<TapdStory & { parentId?: string }>
      parentIds: Set<string>
    }>((acc, row) => {
      const fields = unwrapEntity(row, 'Story')
      const storyId = requiredText(fields.id, 'story id')
      const title = optionalText(fields.name) ?? storyId
      const status = optionalText(fields.status)
      const statusLabel = status ? statusLabels.get(status) : undefined
      const storyOwner = optionalText(fields.owner)
      const iterationName = optionalText(fields.iteration_name)
      const priority = optionalText(fields.priority_label)
      const createdAt = optionalText(fields.created)
      const parentId = optionalText(fields.parent_id)
      if (parentId && parentId !== '0') acc.parentIds.add(parentId)
      acc.stories.push({
        storyId,
        title,
        tapdUrl: urlTemplate.replace('{id}', storyId),
        ...(status ? { status } : {}),
        ...(statusLabel ? { statusLabel } : {}),
        ...(storyOwner ? { owner: storyOwner } : {}),
        ...(iterationName ? { iterationName } : {}),
        ...(priority ? { priority } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(parentId && parentId !== '0' ? { parentId } : {}),
      })
      return acc
    }, { stories: [], parentIds: new Set<string>() })

    let parentStories: TapdParentStory[]
    try {
      const parentDetails = await this.fetchParents([...parentIds], urlTemplate, statusLabels)
      parentStories = this.groupByParent(stories, parentDetails, urlTemplate)
    } catch {
      // 父子分组失败时每个需求自身作为父行，保证看板仍可用
      parentStories = stories.map((story) => ({
        ...story,
        children: [],
        isParentRow: true,
        parentTapdUrl: story.tapdUrl,
      }))
    }
    // bug 计数是展示增强：失败时保留已分组的父子结构，仅不显示计数
    try {
      await this.attachBoardBugs(parentStories, normalizedOwner)
    } catch {
      // 忽略计数失败，父子分组与父链接仍然有效
    }
    // stories 对外保持 TapdStory[] 形态（去掉内部使用的 parentId 附加字段）
    const publicStories: TapdStory[] = stories.map(({ parentId: _parentId, ...story }) => story)
    return { stories: publicStories, parentStories, urlTemplate }
  }

  /**
   * 把一个 TAPD 需求 ID 归一化为父需求 ID：
   * 若该需求是子需求（parent_id 非 0）则返回其父需求 ID，否则返回自身。
   * 用于工作区绑定统一挂在父需求上的口径。TAPD 查询失败时返回原 ID，不阻断绑定保存。
   *
   * @param storyId TAPD 需求 ID（纯数字）
   * @returns 父需求 ID，或查询失败时的原 ID
   */
  async resolveParentStoryId(storyId: string): Promise<string> {
    try {
      const value = await this.callJsonTool('get_stories_or_tasks', {
        workspace_id: tapdWorkspaceId,
        options: {
          entity_type: 'stories',
          id: storyId,
          limit: 1,
          fields: 'id,parent_id',
        },
      })
      const rows = getDataRows(value, 'get_stories_or_tasks')
      const parentId = rows.length ? optionalText(unwrapEntity(rows[0], 'Story').parent_id) : undefined
      return parentId && parentId !== '0' ? parentId : storyId
    } catch {
      return storyId
    }
  }

  /**
   * 批量按 ID 查询父需求详情（标题/状态/链接）。
   * @param parentIds 父需求 ID 列表
   * @param urlTemplate 需求详情链接模板
   * @param statusLabels 状态码到中文名的映射
   * @returns 父需求 ID 到 TapdStory 的映射
   */
  private async fetchParents(
    parentIds: string[],
    urlTemplate: string,
    statusLabels: Map<string, string>,
  ): Promise<Map<string, TapdStory>> {
    const result = new Map<string, TapdStory>()
    if (!parentIds.length) return result
    const fields = `${storyFields},parent_id,children_id`
    // 按 100 分批，避免父需求超过 limit 时响应被截断导致整组降级
    for (let i = 0; i < parentIds.length; i += 100) {
      const slice = parentIds.slice(i, i + 100)
      const value = await this.callJsonTool('get_stories_or_tasks', {
        workspace_id: tapdWorkspaceId,
        options: {
          entity_type: 'stories',
          id: slice.join(','),
          limit: 200,
          fields,
        },
      })
      for (const row of getDataRows(value, 'get_stories_or_tasks')) {
        const f = unwrapEntity(row, 'Story')
        const storyId = requiredText(f.id, 'story id')
        const status = optionalText(f.status)
        result.set(storyId, {
          storyId,
          title: optionalText(f.name) ?? storyId,
          tapdUrl: urlTemplate.replace('{id}', storyId),
          ...(status ? { status } : {}),
          ...(status ? { statusLabel: statusLabels.get(status) } : {}),
          ...(optionalText(f.owner) ? { owner: optionalText(f.owner) } : {}),
          ...(optionalText(f.iteration_name) ? { iterationName: optionalText(f.iteration_name) } : {}),
        })
      }
    }
    return result
  }

  /**
   * 把子需求按父需求分组为看板父行。
   * 无父的子需求（自身即父，或父详情查询缺失）按自身单独成行。
   *
   * @param stories 扁平需求列表（含内部 parentId）
   * @param parentDetails 父需求详情映射
   * @param urlTemplate 需求详情链接模板（父详情缺失时兜底）
   * @returns 父行列表（按首次出现顺序）
   */
  private groupByParent(
    stories: Array<TapdStory & { parentId?: string }>,
    parentDetails: Map<string, TapdStory>,
    urlTemplate: string,
  ): TapdParentStory[] {
    const parents = new Map<string, TapdParentStory>()
    for (const story of stories) {
      // parent_id 为 0 或未返回时，该需求自身即父行
      if (!story.parentId) parents.set(story.storyId, toParentStory(story, []))
    }
    // groupChildrenByParent 为每个 parentId 都建行（父详情缺失时用 ID 兜底），
    // 因此每个有父的子需求都必然落在其父行中，无需额外兜底分支。
    for (const [parentId, children] of groupChildrenByParent(stories)) {
      const detail = parentDetails.get(parentId)
      const fallback: TapdStory = {
        storyId: parentId,
        title: parentId,
        tapdUrl: urlTemplate.replace('{id}', parentId),
      }
      parents.set(parentId, toParentStory(detail ?? fallback, children))
    }
    return [...parents.values()]
  }

  /**
   * 为父行附加「关联到看板 owner 本人」的新增/重开缺陷数。
   * 查询范围为父需求 + 其全部子需求 ID（对齐 cron-prompt 的主+子约定），
   * 但归属判定仍使用当前处理人，而不是父需求 leader。
   *
   * @param parents 父行列表（原地写入 bugNew/bugReopened）
   * @param owner 看板处理人（如“蔡杰鹏”）
   */
  private async attachBoardBugs(parents: TapdParentStory[], owner: string): Promise<void> {
    const relatedValue = await this.callJsonTool('get_related_bugs', {
      workspace_id: tapdWorkspaceId,
      options: { story_id: parents.map(toBoardQueryIds).join(',') },
    })
    const bugsByStory = new Map<string, Set<string>>()
    const allBugIds = new Set<string>()
    for (const row of getDataRows(relatedValue, 'get_related_bugs')) {
      const f = unwrapEntity(row, 'Bug')
      const bugId = requiredText(f.bug_id ?? f.id, 'related bug id')
      const storyId = optionalText(f.story_id)
      if (!storyId) continue
      const set = bugsByStory.get(storyId) ?? new Set<string>()
      set.add(bugId)
      bugsByStory.set(storyId, set)
      allBugIds.add(bugId)
    }
    if (!allBugIds.size) return
    const bugIds = [...allBugIds]
    const fetched = new Map<string, TapdBug>()
    // get_bug 每次 limit 200；按 100 切片避免截断
    for (let i = 0; i < bugIds.length; i += 100) {
      const slice = bugIds.slice(i, i + 100)
      const value = await this.callJsonTool('get_bug', {
        workspace_id: tapdWorkspaceId,
        options: {
          id: slice.join(','),
          status: 'new|reopened',
          limit: 200,
          fields: bugFields,
        },
      })
      for (const bug of parseBoardBugResponse(value, new Set(slice))) {
        fetched.set(bug.id, bug)
      }
    }
    for (const parent of parents) {
      const ids = [parent.storyId, ...parent.children.map((c) => c.storyId)]
      const seen = new Set<string>()
      let bugNew = 0
      let bugReopened = 0
      for (const storyId of ids) {
        for (const bugId of bugsByStory.get(storyId) ?? []) {
          if (seen.has(bugId)) continue
          const bug = fetched.get(bugId)
          if (!bug || !hasOwnerMatch(bug.currentOwner, owner)) continue
          seen.add(bugId)
          if (bug.status === 'new') bugNew += 1
          else if (bug.status === 'reopened') bugReopened += 1
        }
      }
      if (bugNew || bugReopened) {
        parent.bugNew = bugNew
        parent.bugReopened = bugReopened
      }
    }
  }

  /**
   * 读取 TAPD 需求工作流“状态码 → 中文名”的映射。
   * 结果按实例缓存；读取失败时返回空映射，不阻塞需求列表。
   * @returns 状态码到中文名的映射
   */
  private loadStoryStatusLabels(): Promise<Map<string, string>> {
    this.storyStatusLabels ??= (async () => {
      try {
        const types = await this.callJsonTool('get_workitem_types', { workspace_id: tapdWorkspaceId })
        const workitemTypeId = readStoryWorkitemTypeId(types)
        if (!workitemTypeId) return new Map<string, string>()
        const value = await this.callJsonTool('get_workflows_status_map', {
          workspace_id: tapdWorkspaceId,
          options: { system: 'story', workitem_type_id: workitemTypeId },
        })
        return readStatusLabels(value)
      } catch {
        // 状态中文名属于展示增强，失败时退化为显示原始状态码
        return new Map<string, string>()
      }
    })()
    return this.storyStatusLabels
  }

  private async callJsonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result: ToolResult
    try {
      result = await this.tools.callTool('TAPD_MCP_Server', name, args)
    } catch (error) {
      const code = safeErrorCode(error)
      throw new Error(`TAPD ${name} request failed${code ? ` (${code})` : ''}.`, { cause: error })
    }
    if (!result) throw new Error('TAPD MCP is not configured.')
    if (isRecord(result) && result.isError === true) throw new Error(`TAPD ${name} returned an error.`)
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : []
    const text = content
      .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .join('\n')
    if (!text) throw new Error(`TAPD ${name} returned no data.`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`TAPD ${name} returned invalid JSON.`)
    }
  }
}

interface TapdBug {
  id: string
  status: 'new' | 'reopened'
  currentOwner: string
  title?: string
  created?: string
  module?: string
  description?: string
}

function parseStories(value: unknown): StoryDetails[] {
  const rows = getDataRows(value, 'get_stories_or_tasks')
  return rows.map((row) => {
    const fields = unwrapEntity(row, 'Story')
    const storyId = requiredText(fields.id, 'story id')
    return {
      storyId,
      ...(optionalText(fields.iteration_id) ? { iterationId: optionalText(fields.iteration_id) } : {}),
      ...(optionalText(fields.name) ? { title: optionalText(fields.name) } : {}),
      ...(optionalText(fields.status) ? { status: optionalText(fields.status) } : {}),
      ...(optionalText(fields.priority_label) ? { priority: optionalText(fields.priority_label) } : {}),
      ...(optionalText(fields.owner) ? { owner: optionalText(fields.owner) } : {}),
      ...(optionalText(fields.iteration_name) ? { iterationName: optionalText(fields.iteration_name) } : {}),
    }
  })
}

function parseRelatedBugs(value: unknown, storyIds: string[]): RelatedBug[] {
  const rows = getDataRows(value, 'get_related_bugs')
  return rows.map((row) => {
    const fields = unwrapEntity(row, 'Bug')
    const bugId = requiredText(fields.bug_id ?? fields.id, 'related bug id')
    const storyId = optionalText(fields.story_id)
    if (storyId && !storyIds.includes(storyId)) {
      throw new Error('TAPD returned a related bug for an unrequested Story.')
    }
    if (!storyId && storyIds.length !== 1) {
      throw new Error('TAPD related-bug response omitted story_id for a multi-Story query.')
    }
    return { bugId, storyId: storyId ?? storyIds[0] }
  })
}

/**
 * 看板缺陷汇总用的宽松解析：跳过缺少 status/current_owner 的缺陷
 * （TAPD 中新缺陷可能尚未分配处理人），避免单条缺字段导致整个父行降级。
 * 响应结构与截断校验仍与 parseBugResponse 一致。
 *
 * @param value TAPD get_bug 响应
 * @param expectedBugIds 本次请求的缺陷 ID 集合
 * @returns 字段完整的缺陷列表
 */
function parseBoardBugResponse(value: unknown, expectedBugIds: Set<string>): TapdBug[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('TAPD get_bug returned an invalid response.')
  }
  const count = parseCount(value.count)
  if (count === undefined) throw new Error('TAPD get_bug returned an invalid count.')
  if (count > value.data.length) {
    throw new Error(`TAPD get_bug response was truncated (${value.data.length} of ${count} records).`)
  }
  const bugs: TapdBug[] = []
  for (const row of value.data) {
    const fields = unwrapEntity(row, 'Bug')
    const id = optionalText(fields.id)
    const status = optionalText(fields.status)
    const currentOwner = optionalText(fields.current_owner)
    if (!id || !status || !currentOwner || !isBugStatus(status)) continue
    if (!expectedBugIds.has(id)) continue
    bugs.push({
      id,
      status,
      currentOwner,
      ...(optionalText(fields.title) ? { title: optionalText(fields.title) } : {}),
    })
  }
  return bugs
}

function parseIterations(value: unknown): Array<{ id: string; name: string }> {
  const rows = getDataRows(value, 'get_iterations')
  return rows.map((row) => {
    const fields = unwrapEntity(row, 'Iteration')
    return {
      id: requiredText(fields.id, 'iteration id'),
      name: requiredText(fields.name, 'iteration name'),
    }
  })
}

function parseBugResponse(value: unknown, expectedBugIds: Set<string>): TapdBug[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('TAPD get_bug returned an invalid response.')
  }
  const count = parseCount(value.count)
  if (count === undefined) throw new Error('TAPD get_bug returned an invalid count.')
  if (count > value.data.length) {
    throw new Error(`TAPD get_bug response was truncated (${value.data.length} of ${count} records).`)
  }
  const parsedBugs = value.data.map((row) => {
    const fields = unwrapEntity(row, 'Bug')
    const id = requiredText(fields.id, 'bug id')
    const status = requiredText(fields.status, 'bug status')
    const currentOwner = requiredText(fields.current_owner, 'bug current_owner')
    if (!isBugStatus(status)) {
      throw new Error('TAPD get_bug returned a bug outside the requested status filter.')
    }
    return {
      id,
      status,
      currentOwner,
      ...(optionalText(fields.title) ? { title: optionalText(fields.title) } : {}),
      ...(optionalText(fields.created) ? { created: optionalText(fields.created) } : {}),
      ...(optionalText(fields.module) ? { module: optionalText(fields.module) } : {}),
      ...(optionalText(fields.description) ? { description: optionalText(fields.description) } : {}),
    }
  })
  const unexpectedBug = parsedBugs.find((bug) => !expectedBugIds.has(bug.id))
  if (unexpectedBug) throw new Error('TAPD get_bug returned an unrequested Bug.')
  return parsedBugs
}

function getDataRows(value: unknown, toolName: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error(`TAPD ${toolName} returned an invalid response.`)
  }
  const rows = value.data.map((row) => {
    if (!isRecord(row)) throw new Error(`TAPD ${toolName} returned an invalid record.`)
    return row
  })
  if (value.count !== undefined) {
    const count = parseCount(value.count)
    if (count === undefined) throw new Error(`TAPD ${toolName} returned an invalid count.`)
    if (count > rows.length) {
      throw new Error(`TAPD ${toolName} response was truncated (${rows.length} of ${count} records).`)
    }
  }
  return rows
}

function unwrapEntity(value: Record<string, unknown>, entity: string): Record<string, unknown> {
  const nested = value[entity]
  return isRecord(nested) ? nested : value
}

function hasOwnerMatch(currentOwner: string, storyOwner?: string): boolean {
  const normalizedOwner = storyOwner?.trim().toLocaleLowerCase()
  return Boolean(normalizedOwner && currentOwner.toLocaleLowerCase().includes(normalizedOwner))
}

/**
 * 把一条 TAPD 需求包装为看板父行。
 * @param story 父需求（或其自身的子需求兜底）
 * @param children 折叠在其下的子需求
 * @returns 看板父行
 */
function toParentStory(story: TapdStory, children: TapdStory[]): TapdParentStory {
  return {
    ...story,
    children,
    isParentRow: true,
    parentTapdUrl: story.tapdUrl,
  }
}

/**
 * 按 parentId 把子需求分组。
 * @param stories 扁平需求列表（含内部 parentId）
 * @returns parentId → 子需求数组
 */
function groupChildrenByParent(
  stories: Array<TapdStory & { parentId?: string }>,
): Map<string, TapdStory[]> {
  const groups = new Map<string, TapdStory[]>()
  for (const story of stories) {
    if (!story.parentId) continue
    const list = groups.get(story.parentId) ?? []
    const { parentId: _parentId, ...child } = story
    list.push(child)
    groups.set(story.parentId, list)
  }
  return groups
}

/**
 * 生成一次 get_related_bugs 查询用的「父 + 全部子」ID 串。
 * @param parent 看板父行
 * @returns 逗号拼接的 TAPD 需求 ID
 */
function toBoardQueryIds(parent: TapdParentStory): string {
  return [parent.storyId, ...parent.children.map((child) => child.storyId)].join(',')
}

/**
 * 从需求类别列表中取出 entity_type 为 story 的类别 ID。
 * @param value TAPD get_workitem_types 响应
 * @returns 需求类别 ID；缺省或结构非法时返回 undefined
 */
function readStoryWorkitemTypeId(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined
  for (const row of value.data) {
    if (!isRecord(row)) continue
    const type = isRecord(row.WorkitemType) ? row.WorkitemType : row
    if (type.entity_type !== 'story') continue
    const id = optionalText(type.id)
    if (id) return id
  }
  return undefined
}

/**
 * 把工作流状态映射响应转成 Map。
 * TAPD 返回形如 `{ status: 1, data: { status_4: '方案中' }, info: 'success' }`。
 * @param value TAPD get_workflows_status_map 响应
 * @returns 状态码到中文名的映射
 */
function readStatusLabels(value: unknown): Map<string, string> {
  const labels = new Map<string, string>()
  if (!isRecord(value)) return labels
  const data = isRecord(value.data) ? value.data : value
  for (const [code, label] of Object.entries(data)) {
    const text = optionalText(label)
    if (text) labels.set(code, text)
  }
  return labels
}

/**
 * 从 TAPD 响应顶层的 url_template 读取需求详情链接模板。
 * @param value TAPD 工具响应
 * @returns 含 `{id}` 占位符的链接模板；缺省或格式不符时返回 undefined
 */
function readUrlTemplate(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const template = value.url_template
  return typeof template === 'string' && template.includes('{id}') ? template : undefined
}

function isBugStatus(value: string): value is TapdBug['status'] {
  return value === 'new' || value === 'reopened'
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value)
  if (!text) throw new Error(`TAPD response is missing ${field}.`)
  return text
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  return text || undefined
}

/**
 * 从 TAPD MCP 工具响应中解析出记录总数。
 * 支持以下形态：
 * 1. 数字或纯数字字符串，例如 2 或 "2"
 * 2. 计数工具的完整响应对象，例如 {status: 1, data: {count: 17422}, info: "success"}
 * 3. data 为单元素数组且元素内含 count/bug_count/total 字段的对象
 *
 * @param value TAPD 响应中的 count 字段（结构不定）
 * @returns 解析出的非负整数总数；无法识别时返回 undefined
 */
function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (isRecord(value)) {
    const directCount = parseCount(value.count)
    if (directCount !== undefined) return directCount
    // TAPD MCP 的列表接口（如 get_stories_or_tasks）会把 count 工具的完整响应对象
    // 原样嵌入 count 字段，此时 data 是 {count: N} 形态的对象而非数组，需递归解析
    if (isRecord(value.data)) {
      const nestedCount = parseCount(value.data)
      if (nestedCount !== undefined) return nestedCount
    }
    if (Array.isArray(value.data) && value.data.length === 1 && isRecord(value.data[0])) {
      for (const key of ['count', 'bug_count', 'total']) {
        const nestedCount = parseCount(value.data[0][key])
        if (nestedCount !== undefined) return nestedCount
      }
    }
  }
  return undefined
}

/**
 * 把已脱敏的错误转成单行可读文本，并限制长度。
 * @param error 捕获到的错误
 * @returns 单行错误信息（最多 400 字符）
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 400)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeErrorCode(error: unknown): string | undefined {
  if (
    error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code
  }
  return undefined
}
