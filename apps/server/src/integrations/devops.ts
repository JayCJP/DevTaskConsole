import type { Branch, Build } from '@devtask/shared'
import { loadMcpServerConfig } from './mcp-config.js'

interface DevOpsCredentials {
  host: string
  cookie: string
  csrfToken: string
}

export class DevOpsAdapter {
  async checkConnection(): Promise<boolean> {
    const credentials = await this.getCredentials()
    if (!credentials) return false
    await this.request(credentials, '/deploy/group')
    return true
  }

  async getGroups(): Promise<unknown> {
    const credentials = await this.requireCredentials()
    return this.request(credentials, '/deploy/group')
  }

  async getApplications(group: string): Promise<unknown> {
    const credentials = await this.requireCredentials()
    const query = new URLSearchParams({ group })
    return this.request(credentials, `/deploy/application?${query}`)
  }

  async getBranches(app: string, group?: string): Promise<Branch[]> {
    const credentials = await this.requireCredentials()
    const query = new URLSearchParams({ app })
    const result = await this.request(credentials, `/deploy/branch?${query}`)
    const records = Array.isArray(result)
      ? result
      : isRecord(result) && Array.isArray(result.data)
        ? result.data
        : undefined
    if (!records) throw new Error('DevOps returned an invalid branches response.')
    return records.map((record) => {
      if (typeof record === 'string' && record) return { app, ...(group ? { group } : {}), name: record }
      if (!isRecord(record) || typeof record.name !== 'string' || !record.name) {
        throw new Error('DevOps returned a branch with an invalid shape.')
      }
      const lastCommitTime = record.last_commit_time === undefined
        ? undefined
        : toIsoDate(record.last_commit_time)
      if (record.last_commit_time !== undefined && !lastCommitTime) {
        throw new Error('DevOps returned a branch with an invalid last commit time.')
      }
      if (record.commit_id !== undefined && typeof record.commit_id !== 'string') {
        throw new Error('DevOps returned a branch with an invalid commit ID.')
      }
      return {
        app,
        ...(group ? { group } : {}),
        name: record.name,
        ...(typeof record.commit_id === 'string' ? { commitId: record.commit_id } : {}),
        ...(lastCommitTime ? { lastCommitTime } : {}),
      }
    })
  }

  async getBuildRecords(app: string, pageNo = 1, pageSize = 20): Promise<Build[]> {
    if (!Number.isInteger(pageNo) || pageNo < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error('DevOps build pagination parameters are invalid.')
    }
    const credentials = await this.requireCredentials()
    const query = new URLSearchParams({
      app,
      page_no: String(pageNo),
      page_size: String(pageSize),
    })
    const result = await this.request(credentials, `/deploy/build?${query}`)
    if (!isRecord(result) || !Array.isArray(result.detail)) {
      throw new Error('DevOps returned an invalid build records response.')
    }
    return result.detail.map((record) => parseBuild(record, app))
  }

  /**
   * 读取当前 DevOps 登录账号，用于把构建记录筛成“本人触发的构建”。
   * 账号取自 MCP 配置的 `user`（缺省回退 `login_id`），与构建记录的 `last_name` 口径一致。
   * @returns 登录账号；未配置时返回 null
   */
  async getLoginUser(): Promise<string | null> {
    const config = await loadMcpServerConfig('Devops_MCP')
    const candidate = config?.env?.user?.trim() || config?.env?.login_id?.trim()
    return candidate ? candidate : null
  }

  private async getCredentials(): Promise<DevOpsCredentials | null> {
    const config = await loadMcpServerConfig('Devops_MCP')
    if (!config) return null
    const { HOST: host, login_id: loginId, user, csrftoken: csrfToken, sessionid: sessionId } = config.env ?? {}
    if (![host, loginId, user, csrfToken, sessionId].some(Boolean)) return null
    if (
      typeof host !== 'string' || !host
      || typeof loginId !== 'string' || !loginId
      || typeof user !== 'string' || !user
      || typeof csrfToken !== 'string' || !csrfToken
      || typeof sessionId !== 'string' || !sessionId
    ) {
      throw new Error('DevOps configuration requires HOST and all four session values.')
    }
    const hostUrl = new URL(host)
    if (
      !['http:', 'https:'].includes(hostUrl.protocol)
      || (hostUrl.protocol === 'http:' && !isLoopbackHost(hostUrl.hostname))
      || hostUrl.username !== ''
      || hostUrl.password !== ''
      || hostUrl.search !== ''
      || hostUrl.hash !== ''
    ) {
      throw new Error('DevOps HOST must be a credential-free HTTPS URL, or HTTP on loopback for local testing.')
    }
    return {
      host: hostUrl.toString().replace(/\/+$/, ''),
      cookie: `login_id=${loginId}; user=${user}; csrftoken=${csrfToken}; sessionid=${sessionId}`,
      csrfToken,
    }
  }

  private async requireCredentials(): Promise<DevOpsCredentials> {
    const credentials = await this.getCredentials()
    if (!credentials) throw new Error('DevOps is not configured.')
    return credentials
  }

  private async request(credentials: DevOpsCredentials, path: string): Promise<unknown> {
    const response = await fetch(new URL(path.replace(/^\/+/, ''), `${credentials.host}/`), {
      headers: {
        accept: 'application/json',
        cookie: credentials.cookie,
        referer: 'https://devops.vzan.com/index.html',
        'x-csrftoken': credentials.csrfToken,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 403) {
      throw new Error('DevOps session expired (HTTP 403). Refresh the browser session credentials.')
    }
    if (!response.ok) throw new Error(`DevOps request failed with HTTP ${response.status}.`)
    try {
      return await response.json() as unknown
    } catch {
      throw new Error('DevOps returned invalid JSON.')
    }
  }
}

function parseBuild(value: unknown, requestedApp: string): Build {
  if (!isRecord(value)) throw new Error('DevOps returned a build record with an invalid shape.')
  const identifier = value.id ?? value.number
  if (typeof identifier !== 'string' && typeof identifier !== 'number') {
    throw new Error('DevOps returned a build record without an identifier.')
  }
  const succeed = value.succeed === 1 || value.succeed === '1'
    ? true
    : value.succeed === 0 || value.succeed === '0'
      ? false
      : null
  const buildDate = toIsoDate(value.build_date)
  const durationTime = toNonNegativeNumber(value.duration_time)
  const fileUrl = isValidUrl(value.file_url) ? value.file_url : undefined
  return {
    id: String(identifier),
    app: typeof value.alias === 'string' && value.alias ? value.alias : requestedApp,
    ...(typeof value.number === 'string' || typeof value.number === 'number' ? { number: String(value.number) } : {}),
    ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    ...(typeof value.commit_id === 'string' ? { commitId: value.commit_id } : {}),
    succeed,
    ...(buildDate ? { buildDate } : {}),
    ...(durationTime !== undefined ? { durationTime } : {}),
    ...(typeof value.last_name === 'string' ? { operator: value.last_name } : {}),
    ...(fileUrl ? { fileUrl } : {}),
  }
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}
