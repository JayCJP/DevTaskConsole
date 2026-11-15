import { defaultTapdWorkspaceId, type Bug, type Requirement, type TapdStory } from '@devtask/shared'
import { mcpClientRegistry, type McpClientRegistry } from './mcp-client.js'

const requiredReadTools = ['get_stories_or_tasks', 'get_related_bugs', 'get_bug', 'get_iterations']
type ToolListing = Awaited<ReturnType<McpClientRegistry['listTools']>>
type ToolResult = Awaited<ReturnType<McpClientRegistry['callTool']>>
const tapdWorkspaceId = defaultTapdWorkspaceId
const storyFields = 'id,name,status,priority_label,owner,iteration_id,iteration_name'
/** 按处理人列需求时额外需要的创建时间字段 */
const ownedStoryFields = `${storyFields},created`
/** TAPD 未返回 url_template 时使用的需求详情链接模板 */
const defaultStoryUrlTemplate = 'https://www.tapd.cn/38260062/prong/stories/view/{id}'
const bugFields = 'id,title,status,current_owner,created,module,description'

interface RelatedBug {
  bugId: string
  storyId?: string
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

  constructor(
    private readonly tools: Pick<McpClientRegistry, 'listTools' | 'callTool'> = mcpClientRegistry,
  ) {}

  async checkConnection(): Promise<boolean> {
    let listing: ToolListing
    try {
      listing = await this.tools.listTools('TAPD_MCP_Server')
    } catch (error) {
      const code = safeErrorCode(error)
      const detail = code ? ` (${code})` : ''
      throw new Error(`TAPD MCP connection failed${detail}. Check its local command and configuration.`, { cause: error })
    }
    if (!listing) return false
    const available = new Set(listing.tools.map((tool) => tool.name))
    const missing = requiredReadTools.filter((name) => !available.has(name))
    if (missing.length) {
      throw new Error(`TAPD MCP is missing required read-only tools: ${missing.join(', ')}.`)
    }
    return true
  }

  async aggregate(requirements: Requirement[]): Promise<{ requirements: Requirement[]; bugs: Bug[] }> {
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
    const matchedBugs: Bug[] = []
    const enrichedRequirements = requirements.map((requirement) => {
      const tapdStoryId = requirement.tapdStoryId
      const story = tapdStoryId ? storyById.get(tapdStoryId) : undefined
      const bugIdsForStory = tapdStoryId ? relatedByStory.get(tapdStoryId) : undefined
      if (!story && !bugIdsForStory) {
        return tapdStoryId ? { ...requirement, tapdWorkspaceId } : requirement
      }
      const matchingBugs = bugs.filter((bug) =>
        bugIdsForStory?.has(bug.id) === true
        && hasOwnerMatch(bug.currentOwner, story?.owner),
      )
      for (const bug of matchingBugs) {
        const detail = bugsById.get(bug.id)
        if (detail) matchedBugs.push({
          id: detail.id,
          storyId: requirement.storyId,
          status: detail.status,
          currentOwner: detail.currentOwner,
          ...(detail.title ? { title: detail.title } : {}),
          ...(detail.created ? { created: detail.created } : {}),
          ...(detail.module ? { module: detail.module } : {}),
          ...(detail.description ? { description: detail.description } : {}),
        })
      }
      return {
        ...requirement,
        ...(tapdStoryId ? { tapdWorkspaceId } : {}),
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
      }
    })
    return { requirements: enrichedRequirements, bugs: matchedBugs }
  }

  async enrichRequirements(requirements: Requirement[]): Promise<Requirement[]> {
    return (await this.aggregate(requirements)).requirements
  }

  /**
   * 按处理人查询 TAPD 需求，作为看板的数据元。
   * 只读查询，不按标题或仓库名做本地猜测。
   * @param owner TAPD 处理人姓名，例如“蔡杰鹏”
   * @returns 需求列表与 TAPD 详情链接模板
   * @throws Error 处理人为空、MCP 未配置或响应结构非法
   */
  async listOwnedStories(owner: string): Promise<{ stories: TapdStory[]; urlTemplate: string }> {
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
    const stories = rows.map((row) => {
      const fields = unwrapEntity(row, 'Story')
      const storyId = requiredText(fields.id, 'story id')
      const title = optionalText(fields.name) ?? storyId
      const status = optionalText(fields.status)
      const statusLabel = status ? statusLabels.get(status) : undefined
      const storyOwner = optionalText(fields.owner)
      const iterationName = optionalText(fields.iteration_name)
      const priority = optionalText(fields.priority_label)
      const createdAt = optionalText(fields.created)
      return {
        storyId,
        title,
        tapdUrl: urlTemplate.replace('{id}', storyId),
        ...(status ? { status } : {}),
        ...(statusLabel ? { statusLabel } : {}),
        ...(storyOwner ? { owner: storyOwner } : {}),
        ...(iterationName ? { iterationName } : {}),
        ...(priority ? { priority } : {}),
        ...(createdAt ? { createdAt } : {}),
      }
    })
    return { stories, urlTemplate }
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
