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
    return result.map((mergeRequest) => {
      if (
        !isRecord(mergeRequest)
        || !Number.isInteger(mergeRequest.id)
        || typeof mergeRequest.title !== 'string'
        || typeof mergeRequest.source_branch !== 'string'
        || typeof mergeRequest.target_branch !== 'string'
        || typeof mergeRequest.state !== 'string'
      ) {
        throw new Error('GitLab returned a merge request with an invalid shape.')
      }
      // 作者用户名用于前端“只显示本人的发布内容”，字段缺失时不影响其它字段
      const authorUsername = isRecord(mergeRequest.author) && typeof mergeRequest.author.username === 'string'
        ? mergeRequest.author.username
        : undefined
      return {
        projectId,
        id: String(mergeRequest.iid ?? mergeRequest.id),
        title: mergeRequest.title,
        sourceBranch: mergeRequest.source_branch,
        targetBranch: mergeRequest.target_branch,
        state: mergeRequest.state,
        ...(authorUsername ? { authorUsername } : {}),
        ...(typeof mergeRequest.detailed_merge_status === 'string'
          ? { mergeStatus: mergeRequest.detailed_merge_status }
          : typeof mergeRequest.merge_status === 'string'
            ? { mergeStatus: mergeRequest.merge_status }
            : {}),
        ...(toIsoDate(mergeRequest.merged_at) ? { mergedAt: toIsoDate(mergeRequest.merged_at) } : {}),
        ...(typeof mergeRequest.web_url === 'string' ? { webUrl: mergeRequest.web_url } : {}),
      }
    })
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

  private async request(credentials: GitLabCredentials, path: string): Promise<unknown> {
    const baseUrl = `${credentials.apiUrl.replace(/\/+$/, '')}/`
    const response = await fetch(new URL(path.replace(/^\/+/, ''), baseUrl), {
      headers: {
        accept: 'application/json',
        'private-token': credentials.personalAccessToken,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`GitLab request failed with HTTP ${response.status}.`)
    }
    try {
      return await response.json() as unknown
    } catch {
      throw new Error('GitLab returned invalid JSON.')
    }
  }
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
