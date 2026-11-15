import type { MergeRequestDiffSummary } from '@devtask/shared'
import { loadMcpServerConfig } from './mcp-config.js'

interface GitLabCredentials {
  apiUrl: string
  personalAccessToken: string
}

export interface GitLabProject {
  id: number
  pathWithNamespace: string
}

export interface GitLabMergeRequest {
  projectId: number
  id: string
  title: string
  sourceBranch: string
  targetBranch: string
  state: string
  mergeStatus?: string
  mergedAt?: string
  approvals?: { approved: boolean; approvedBy: string[] }
  changesCount?: number
  changedFiles?: string[]
  webUrl?: string
  /** MR 作者的 GitLab 用户名 */
  authorUsername?: string
}

/** 当前 GitLab 访问令牌对应的账号信息 */
export interface GitLabCurrentUser {
  username: string
  name: string
}

/** 创建合并请求的入参 */
export interface GitLabMergeRequestCreateInput {
  /** 源分支（项目当前发布分支） */
  sourceBranch: string
  /** 目标分支（基线分支） */
  targetBranch: string
  /** MR 标题 */
  title: string
  /** MR 描述 */
  description?: string
}

export class GitLabAdapter {
  /** 当前令牌对应用户缓存；仅在成功识别后写入，失败不缓存以便下次重试 */
  private currentUserCache: GitLabCurrentUser | undefined

  async checkConnection(): Promise<boolean> {
    const credentials = await this.getCredentials()
    if (!credentials) return false
    await this.request(credentials, '/projects?per_page=1')
    return true
  }

  async findProjects(search: string): Promise<GitLabProject[]> {
    const credentials = await this.requireCredentials()
    const result = await this.request(credentials, `/projects?search=${encodeURIComponent(search)}&per_page=100`)
    if (!Array.isArray(result)) throw new Error('GitLab returned an invalid projects response.')
    return result.map((project) => {
      if (
        !isRecord(project)
        || typeof project.id !== 'number'
        || !Number.isInteger(project.id)
        || typeof project.path_with_namespace !== 'string'
      ) {
        throw new Error('GitLab returned a project with an invalid shape.')
      }
      return { id: project.id, pathWithNamespace: project.path_with_namespace }
    })
  }

  /**
   * 查询当前访问令牌对应的 GitLab 账号；失败时返回 null 且不缓存失败结果。
   * @returns 当前账号用户名与显示名，未配置或查询失败时为 null
   */
  async getCurrentUser(): Promise<GitLabCurrentUser | null> {
    if (this.currentUserCache !== undefined) return this.currentUserCache
    try {
      const credentials = await this.requireCredentials()
      const result = await this.request(credentials, '/user')
      if (!isRecord(result) || typeof result.username !== 'string' || !result.username) {
        throw new Error('GitLab returned an invalid current user response.')
      }
      this.currentUserCache = {
        username: result.username,
        name: typeof result.name === 'string' && result.name ? result.name : result.username,
      }
      return this.currentUserCache
    } catch {
      // 身份识别只用于“只看我的”筛选，失败时退化为不筛选，不阻塞快照
      return null
    }
  }

  async listMergeRequests(projectId: number, sourceBranch: string): Promise<GitLabMergeRequest[]> {
    const credentials = await this.requireCredentials()
    const query = new URLSearchParams({
      source_branch: sourceBranch,
      state: 'all',
      per_page: '100',
    })
    const result = await this.request(credentials, `/projects/${projectId}/merge_requests?${query}`)
    if (!Array.isArray(result)) throw new Error('GitLab returned an invalid merge request response.')
    return result.map((mergeRequest) => toMergeRequest(projectId, mergeRequest))
  }

  /**
   * 创建一个合并请求：把项目的源分支合并到指定目标分支。
   * 只创建 MR，不改动本地仓库、不推送代码，也不设置自动合并。
   * @param projectId GitLab 项目 ID
   * @param input 源分支、目标分支、标题与描述
   * @returns 新建的合并请求
   * @throws Error GitLab 拒绝创建（如源分支不存在、MR 已存在）时抛出带状态码的错误
   */
  async createMergeRequest(
    projectId: number,
    input: GitLabMergeRequestCreateInput,
  ): Promise<GitLabMergeRequest> {
    const credentials = await this.requireCredentials()
    const result = await this.request(credentials, `/projects/${projectId}/merge_requests`, {
      method: 'POST',
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        // 保留源分支，工作区后续仍以该分支作为开发分支
        remove_source_branch: false,
      },
    })
    return toMergeRequest(projectId, result)
  }

  async getMergeRequestDetails(projectId: number, iid: string): Promise<Pick<
    GitLabMergeRequest,
    'approvals' | 'changesCount' | 'changedFiles'
  >> {
    const credentials = await this.requireCredentials()
    const prefix = `/projects/${projectId}/merge_requests/${encodeURIComponent(iid)}`
    const [approvalResult, changeResult, requestResult] = await Promise.all([
      this.request(credentials, `${prefix}/approvals`),
      this.request(credentials, `${prefix}/changes`),
      this.request(credentials, prefix),
    ])
    if (
      !isRecord(approvalResult)
      || typeof approvalResult.approved !== 'boolean'
      || !Array.isArray(approvalResult.approved_by)
    ) {
      throw new Error('GitLab returned an invalid merge request approvals response.')
    }
    const approvedBy = approvalResult.approved_by.map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.user) || typeof entry.user.name !== 'string') {
        throw new Error('GitLab returned an invalid merge request approver.')
      }
      return entry.user.name
    })
    if (!isRecord(requestResult) || typeof requestResult.changes_count !== 'string') {
      throw new Error('GitLab returned an invalid merge request detail response.')
    }
    const changesCount = Number(requestResult.changes_count)
    if (!Number.isSafeInteger(changesCount) || changesCount < 0) {
      throw new Error('GitLab returned an invalid merge request changes count.')
    }
    if (!isRecord(changeResult) || !Array.isArray(changeResult.changes)) {
      throw new Error('GitLab returned an invalid merge request changes response.')
    }
    const changedFiles = changeResult.changes.map((change) => {
      if (
        !isRecord(change)
        || typeof change.new_path !== 'string'
        || typeof change.old_path !== 'string'
      ) {
        throw new Error('GitLab returned a changed file with an invalid shape.')
      }
      return change.new_path === change.old_path
        ? change.new_path
        : `${change.old_path} → ${change.new_path}`
    })
    return {
      approvals: { approved: approvalResult.approved, approvedBy },
      changesCount,
      changedFiles,
    }
  }

  /**
   * 读取 MR 的 diff 摘要：变更文件数、增删行与热点文件。
   * 大 MR 的 diff 响应可能非常大，这里限制参与统计的文件数，
   * 超出时把 truncated 置为 true，只保证「已统计部分」准确。
   * @param projectId GitLab 项目 ID
   * @param iid MR 的 iid
   * @param maxFiles 参与统计的文件数上限，默认 50
   * @returns diff 摘要
   */
  async getMergeRequestDiffSummary(
    projectId: number,
    iid: string,
    maxFiles = 50,
  ): Promise<MergeRequestDiffSummary> {
    const credentials = await this.requireCredentials()
    const result = await this.request(
      credentials,
      `/projects/${projectId}/merge_requests/${encodeURIComponent(iid)}/changes`,
    )
    if (!isRecord(result) || !Array.isArray(result.changes)) {
      throw new Error('GitLab returned an invalid merge request changes response.')
    }
    const limit = Math.max(1, Math.min(200, Math.trunc(maxFiles)))
    const changes = result.changes.slice(0, limit)
    let additions = 0
    let deletions = 0
    const hotFiles: Array<{ path: string; weight: number }> = []
    for (const change of changes) {
      if (!isRecord(change) || typeof change.new_path !== 'string') {
        throw new Error('GitLab returned a changed file with an invalid shape.')
      }
      const stats = countDiffLines(typeof change.diff === 'string' ? change.diff : '')
      additions += stats.additions
      deletions += stats.deletions
      hotFiles.push({ path: change.new_path, weight: stats.additions + stats.deletions })
    }
    hotFiles.sort((left, right) => right.weight - left.weight || left.path.localeCompare(right.path))
    return {
      filesChanged: result.changes.length,
      additions,
      deletions,
      hotFiles: hotFiles.slice(0, 5).map((file) => file.path),
      truncated: result.changes.length > limit,
    }
  }

  private async getCredentials(): Promise<GitLabCredentials | null> {
    const config = await loadMcpServerConfig('GitLab')
    if (!config) return null
    const apiUrl = config.env?.GITLAB_API_URL
    const personalAccessToken = config.env?.GITLAB_PERSONAL_ACCESS_TOKEN
    if (!apiUrl && !personalAccessToken) return null
    if (!apiUrl || !personalAccessToken) {
      throw new Error('GitLab configuration requires both API URL and personal access token.')
    }
    const url = new URL(apiUrl)
    if (
      !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('GitLab API URL must be a credential-free HTTPS URL, or HTTP on loopback for local testing.')
    }
    return { apiUrl: url.toString().replace(/\/+$/, ''), personalAccessToken }
  }

  private async requireCredentials(): Promise<GitLabCredentials> {
    const credentials = await this.getCredentials()
    if (!credentials) throw new Error('GitLab is not configured.')
    return credentials
  }

  /**
   * 调用 GitLab REST API。
   * @param credentials 当前 GitLab 凭据
   * @param path 相对 API 根目录的路径（如 `/projects/1/merge_requests`）
   * @param init 可选方法与 JSON 请求体；缺省为 GET
   * @returns 解析后的应答 JSON
   * @throws Error 网络失败、非 2xx 应答或应答不是合法 JSON
   */
  private async request(
    credentials: GitLabCredentials,
    path: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const baseUrl = `${credentials.apiUrl.replace(/\/+$/, '')}/`
    const response = await fetch(new URL(path.replace(/^\/+/, ''), baseUrl), {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'private-token': credentials.personalAccessToken,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`GitLab request failed with HTTP ${response.status}.${await errorDetailOf(response)}`)
    }
    try {
      return await response.json() as unknown
    } catch {
      throw new Error('GitLab returned invalid JSON.')
    }
  }
}

/**
 * 把 GitLab 返回的单条 MR 转成内部结构，并校验必要字段。
 * @param projectId GitLab 项目 ID
 * @param value GitLab 返回的 MR 对象
 * @returns 内部 MR 结构
 * @throws Error 字段缺失或类型非法
 */
function toMergeRequest(projectId: number, value: unknown): GitLabMergeRequest {
  if (
    !isRecord(value)
    || !Number.isInteger(value.id)
    || typeof value.title !== 'string'
    || typeof value.source_branch !== 'string'
    || typeof value.target_branch !== 'string'
    || typeof value.state !== 'string'
  ) {
    throw new Error('GitLab returned a merge request with an invalid shape.')
  }
  // 作者用户名用于前端“只显示本人的发布内容”，字段缺失时不影响其它字段
  const authorUsername = isRecord(value.author) && typeof value.author.username === 'string'
    ? value.author.username
    : undefined
  const mergedAt = toIsoDate(value.merged_at)
  return {
    projectId,
    id: String(value.iid ?? value.id),
    title: value.title,
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    state: value.state,
    ...(authorUsername ? { authorUsername } : {}),
    ...(typeof value.detailed_merge_status === 'string'
      ? { mergeStatus: value.detailed_merge_status }
      : typeof value.merge_status === 'string'
        ? { mergeStatus: value.merge_status }
        : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(typeof value.web_url === 'string' ? { webUrl: value.web_url } : {}),
  }
}

/**
 * 读取 GitLab 错误响应中的可展示说明（如「源分支不存在」）。
 * 只解析结构化的 `message` 字段，且原样回传响应体会把凭据等内容带进错误消息，因此不做兜底透传。
 * @param response 非 2xx 的 GitLab 应答
 * @returns 以空格开头的说明文本；无法解析时为空字符串
 */
async function errorDetailOf(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown
    if (!isRecord(payload) || typeof payload.message !== 'string') return ''
    const message = payload.message.trim().slice(0, 300)
    return message ? ` ${message}` : ''
  } catch {
    // 非 JSON 应答（如网关错误页）不解析，避免透传不可控内容
    return ''
  }
}

/**
 * 统计单个文件 diff 的新增与删除行数。
 * 只统计以单个 `+`/`-` 开头的内容行，跳过 diff 头部的 `+++`/`---` 标记。
 * @param diff 文件 diff 文本
 * @returns 新增与删除行数
 */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/**
 * 把 GitLab 时间字段统一成 ISO UTC 字符串。
 * GitLab 会返回带时区偏移的格式（如 `2026-11-11T12:16:22.144+08:00`），
 * 而快照与前端约定统一使用 ISO UTC，避免校验失败。
 * @param value GitLab 返回的时间字段
 * @returns ISO UTC 字符串；无法解析时返回 undefined
 */
function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}
