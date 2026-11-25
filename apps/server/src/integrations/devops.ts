import type { Branch, Build, DeployFact } from '@devtask/shared'
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
      if (typeof record === 'string' && record)
        return { app, ...(group ? { group } : {}), name: record }
      if (!isRecord(record) || typeof record.name !== 'string' || !record.name) {
        throw new Error('DevOps returned a branch with an invalid shape.')
      }
      const lastCommitTime =
        record.last_commit_time === undefined ? undefined : toIsoDate(record.last_commit_time)
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
    if (
      !Number.isInteger(pageNo) ||
      pageNo < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
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
   * 输出发布口径事实（R16 / R17）。
   * DevOps 现有工具只提供构建记录，没有部署状态查询，因此：
   * - 构建成功不能被表述为「已部署」；只能说明无法确认线上版本。
   * - dev 与 test 是否为同一环境尚未确认，发布链按钮口径不可靠。
   * 这里固定返回 unknown 与明确文案，避免前端或调用方臆断。
   * @param app DevOps 应用名，用于文案中指名对象
   * @returns 部署事实与环境关系事实
   */
  getReleaseFacts(app: string): { deployment: DeployFact; environment: DeployFact } {
    return {
      deployment: {
        fact: 'unknown',
        statement: `无法确认 ${app} 的当前线上部署版本：DevOps 只提供构建记录，构建成功不等于已部署。`,
      },
      environment: {
        fact: 'unknown',
        statement:
          'dev 与 test 环境的关系尚未确认，发布链按钮口径不可靠，因此触发构建、部署等写操作保持禁用。',
      },
    }
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
    const {
      HOST: host,
      login_id: loginId,
      user,
      csrftoken: csrfToken,
      sessionid: sessionId,
    } = config.env ?? {}
    if (![host, loginId, user, csrfToken, sessionId].some(Boolean)) return null
    if (
      typeof host !== 'string' ||
      !host ||
      typeof loginId !== 'string' ||
      !loginId ||
      typeof user !== 'string' ||
      !user ||
      typeof csrfToken !== 'string' ||
      !csrfToken ||
      typeof sessionId !== 'string' ||
      !sessionId
    ) {
      throw new Error('DevOps configuration requires HOST and all four session values.')
    }
    const hostUrl = new URL(host)
    if (
      !['http:', 'https:'].includes(hostUrl.protocol) ||
      (hostUrl.protocol === 'http:' && !isLoopbackHost(hostUrl.hostname)) ||
      hostUrl.username !== '' ||
      hostUrl.password !== '' ||
      hostUrl.search !== '' ||
      hostUrl.hash !== ''
    ) {
      throw new Error(
        'DevOps HOST must be a credential-free HTTPS URL, or HTTP on loopback for local testing.',
      )
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

  /**
   * 触发一次构建（POST /deploy/build）。
   * 参数按调用方给定的 group/app/branch/env 透传，build_other 由上层按环境映射后传入，
   * 这里不自行猜测分支或环境，避免与 Harness 发布助手的口径冲突。
   * @param input 构建参数（app/group/branch/buildOther/buildType/liveDockerBranch 等）
   * @returns DevOps 原始响应；无法解析为 JSON 时返回 undefined（写操作以 HTTP 状态为准）
   */
  async triggerBuild(input: {
    group: string
    app: string
    branch: string
    buildOther: string
    /** 仅 dev 环境传 env，其余环境在请求体中省略该字段 */
    env?: string
    buildType?: string
    liveDockerBranch?: string
    committedId?: string
    committedMsg?: string
  }): Promise<unknown> {
    const credentials = await this.requireCredentials()
    const payload: Record<string, unknown> = {
      group: input.group,
      app: input.app,
      branch: input.branch,
      committed_id: input.committedId ?? '',
      committed_msg: input.committedMsg ?? '',
      build_other: input.buildOther,
      build_type: input.buildType ?? 'docker_build',
      live_dcoker_branch: input.liveDockerBranch ?? 'origin/master',
    }
    // 只有 dev 环境携带 env；其它环境完全不出现该字段
    if (input.env !== undefined) payload.env = input.env
    return this.request(credentials, '/deploy/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  /**
   * 批量发布制品到指定环境（POST /deploy/deploy_multiple）。
   * 仅把调用方给定且已通过环境白名单校验的 urls/env 透传给 DevOps，
   * 不自行猜测环境，也不宣称发布即代表已上线（DevOps 为异步写操作）。
   * @param input 发布参数（制品 URL 列表、目标环境、强制标记、超时秒数）
   * @returns DevOps 原始响应；无法解析为 JSON 时返回 undefined（以 HTTP 状态为准）
   */
  async deployMultiple(input: {
    urls: string[]
    env: string
    force?: string
    timeout?: number
  }): Promise<unknown> {
    const credentials = await this.requireCredentials()
    const payload: Record<string, unknown> = {
      // DevOps /deploy/deploy_multiple 要求 urls 为「换行分隔的字符串」，
      // 而非 JSON 数组；参考 mcp-server.js 的 urls.join('\n') 口径。
      // 传数组会导致服务端无法正确解析制品地址，发布流程挂起直至网关 504。
      urls: input.urls.join('\n'),
      env: input.env,
      force: input.force ?? '0',
      timeout: input.timeout ?? 300,
    }
    return this.request(credentials, '/deploy/deploy_multiple', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // 发布只需拿到 DevOps "已接受" 回执，但 DevOps 侧按 timeout 秒处理后再回包。
      // 客户端超时必须大于服务端 timeout（这里多给 60 秒缓冲），否则会先于回执 abort，
      // 把一次成功的发布误报成 "The operation was aborted due to timeout"。
      timeoutMs: (input.timeout ?? 300) * 1000 + 60_000,
    })
  }

  private async request(
    credentials: DevOpsCredentials,
    path: string,
    init?: (RequestInit & { timeoutMs?: number }) | undefined,
  ): Promise<unknown> {
    const response = await fetch(new URL(path.replace(/^\/+/, ''), `${credentials.host}/`), {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { body: init.body } : {}),
      headers: {
        accept: 'application/json',
        cookie: credentials.cookie,
        referer: 'https://devops.vzan.com/index.html',
        'x-csrftoken': credentials.csrfToken,
        ...(init?.headers ?? {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
    })
    if (response.status === 403) {
      throw new Error('DevOps session expired (HTTP 403). Refresh the browser session credentials.')
    }
    if (!response.ok) {
      // 5xx（如 504 网关超时）常由参数格式或 DevOps 侧处理异常引起，
      // 把实际请求的完整 URL 带进错误信息，便于定位是地址还是参数问题。
      const targetUrl = new URL(path.replace(/^\/+/, ''), `${credentials.host}/`).toString()
      throw new Error(`DevOps request failed with HTTP ${response.status} (${targetUrl}).`)
    }
    try {
      return (await response.json()) as unknown
    } catch {
      // 写操作（触发构建）常返回 200/201 空体，此时以 HTTP 状态为准，不判失败。
      return undefined
    }
  }
}

function parseBuild(value: unknown, requestedApp: string): Build {
  if (!isRecord(value)) throw new Error('DevOps returned a build record with an invalid shape.')
  const identifier = value.id ?? value.number
  if (typeof identifier !== 'string' && typeof identifier !== 'number') {
    throw new Error('DevOps returned a build record without an identifier.')
  }
  const succeed =
    value.succeed === 1 || value.succeed === '1'
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
    ...(typeof value.number === 'string' || typeof value.number === 'number'
      ? { number: String(value.number) }
      : {}),
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
