import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadMcpServerConfig, type McpServerConfig } from './mcp-config.js'

/**
 * MCP 子进程启动或握手失败。
 * 携带可读原因（含子进程 stderr 摘要）与允许的尝试次数。
 */
export class McpConnectError extends Error {
  /** 该错误允许的总尝试次数：1 表示不重试 */
  readonly maxAttempts: number

  constructor(message: string, maxAttempts = 1, cause?: unknown) {
    super(message, { cause })
    this.name = 'McpConnectError'
    this.maxAttempts = Math.max(1, maxAttempts)
  }
}

/** 连接失败后的冷却时间：同一进程内不反复拉起子进程，避免把上游限流放大 */
const failureCooldownMs = 30_000
/** 重试等待时间：越靠后的间隔越长，整体控制在 2 秒内，避免拖慢快照请求 */
const retryDelaysMs = [500, 1_500]
/** 未在配置中指定 timeout 时的握手超时 */
const defaultConnectTimeoutMs = 60_000
/** 保留的子进程输出上限，用于错误提示 */
const stderrTailLimit = 1_200

/** 一次 MCP 连接尝试：`client` 在握手成功后回填，用于判断失败是否来自当前连接 */
interface ClientEntry {
  promise: Promise<Client | null>
  client?: Client
}

export class McpClientRegistry {
  /** 每个服务器当前登记的那次连接尝试，`client` 在握手成功后回填 */
  private readonly clients = new Map<string, ClientEntry>()
  private readonly failures = new Map<string, { at: number; error: McpConnectError }>()

  async listTools(serverName: string) {
    const client = await this.getClient(serverName)
    if (!client) return null
    try {
      return await client.listTools()
    } catch (error) {
      await this.invalidateIfBroken(serverName, client, error)
      throw error
    }
  }

  async callTool(serverName: string, name: string, args: Record<string, unknown>) {
    const client = await this.getClient(serverName)
    if (!client) return null
    try {
      return await client.callTool({ name, arguments: args })
    } catch (error) {
      await this.invalidateIfBroken(serverName, client, error)
      throw error
    }
  }

  async close(): Promise<void> {
    const entries = [...this.clients.values()]
    this.clients.clear()
    this.failures.clear()
    const connections = await Promise.allSettled(entries.map((entry) => entry.promise))
    await Promise.all(connections.flatMap((connection) =>
      connection.status === 'fulfilled' && connection.value
        ? [connection.value.close()]
        : [],
    ))
  }

  private async getClient(serverName: string): Promise<Client | null> {
    // 冷却期内直接复用上次的失败原因，避免高频刷新反复拉起子进程
    const failure = this.failures.get(serverName)
    if (failure) {
      if (Date.now() - failure.at < failureCooldownMs) throw failure.error
      this.failures.delete(serverName)
    }

    let entry = this.clients.get(serverName)
    if (!entry) {
      const created: ClientEntry = { promise: this.connect(serverName) }
      entry = created
      this.clients.set(serverName, created)
      void created.promise.catch(() => {
        if (this.clients.get(serverName) === created) this.clients.delete(serverName)
      })
    }
    const client = await entry.promise
    if (client) entry.client = client
    else if (this.clients.get(serverName) === entry) this.clients.delete(serverName)
    return client
  }

  /**
   * 传输层断开时丢弃缓存的客户端，让下一次请求重新拉起子进程。
   *
   * 只处理“连接已断开”类错误：业务错误（例如上游返回 isError、参数非法）
   * 不应触发重启子进程，否则每次业务失败都会多一次 `users/info` 调用。
   * 这里不在当前请求内重试，避免一次操作打两遍上游。
   *
   * @param serverName MCP 配置中的服务器名
   * @param client 本次调用失败的客户端
   * @param error 调用抛出的错误
   * @returns Promise<void>
   */
  private async invalidateIfBroken(serverName: string, client: Client, error: unknown): Promise<void> {
    if (!isTransportFailure(error)) return
    // 只清掉“确实由这个客户端占用”的登记，避免把并发中刚建立的新连接一起删掉；
    // 断开的客户端无论登记是否还在都关闭，防止遗留子进程。
    const entry = this.clients.get(serverName)
    if (entry?.client === client) this.clients.delete(serverName)
    await client.close().catch(() => undefined)
  }

  /**
   * 连接指定 MCP 服务器，失败时按瞬时错误重试。
   * @param serverName MCP 配置中的服务器名
   * @returns 已连接的客户端；未配置时返回 null
   * @throws McpConnectError 子进程无法启动或握手失败
   */
  private async connect(serverName: string): Promise<Client | null> {
    const config = await loadMcpServerConfig(serverName)
    if (!config) return null

    let lastError: McpConnectError | undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.spawn(serverName, config)
      } catch (error) {
        const connectError = error instanceof McpConnectError
          ? error
          : new McpConnectError(`${serverName} MCP 启动失败：${messageOf(error)}`, 1, error)
        lastError = connectError
        const wait = retryDelaysMs[attempt]
        if (attempt + 1 >= connectError.maxAttempts || wait === undefined) break
        await delay(wait)
      }
    }
    const failure = lastError ?? new McpConnectError(`${serverName} MCP 启动失败。`)
    this.failures.set(serverName, { at: Date.now(), error: failure })
    throw failure
  }

  /**
   * 拉起 MCP 子进程并完成握手。
   * @param serverName MCP 配置中的服务器名
   * @param config 子进程启动配置
   * @returns 已连接的客户端
   * @throws McpConnectError 启动超时、进程退出或握手失败
   */
  private async spawn(serverName: string, config: McpServerConfig): Promise<Client> {
    const chunks: string[] = []
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: config.env } : {}),
      // 采集子进程输出，子进程崩溃时用它说明原因（如上游 429、缺少依赖）
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      chunks.push(chunk.toString())
      while (chunks.join('').length > stderrTailLimit && chunks.length > 1) chunks.shift()
    })

    const client = new Client({ name: 'devtask-console', version: '0.1.0' })
    try {
      await withTimeout(client.connect(transport), config.timeout ?? defaultConnectTimeoutMs)
      return client
    } catch (error) {
      await client.close().catch(() => undefined)
      const stderrTail = redactSecrets(chunks.join('').trim(), config.env).slice(-stderrTailLimit)
      const summary = summarizeFailure(`${messageOf(error)}\n${stderrTail}`, stderrTail)
      const message = `${serverName} MCP 启动失败：${messageOf(error)}${summary ? ` - ${summary.text}` : ''}`
      throw new McpConnectError(message, summary?.maxAttempts ?? 1, error)
    }
  }
}

export const mcpClientRegistry = new McpClientRegistry()

/**
 * 判断失败是否属于“稍后重试可能成功”的瞬时错误。
 * @param text 错误信息与子进程输出
 * @returns 是否可重试
 */
function isRetryable(text: string): boolean {
  return /429|too\s*many\s*request|toomanyrequest|connection\s*closed|econnreset|etimedout|timed?\s*out/i.test(text)
}

/**
 * 判断错误是否属于传输层断开。
 * 只有这类错误才值得重建 MCP 连接；业务错误（上游 isError、参数非法、
 * 上游限流响应）重建连接既无用、又会多一次子进程启动请求。
 * @param error 调用抛出的错误
 * @returns 是否需要重建连接
 */
export function isTransportFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /connection closed|not connected|transport (?:closed|error)|epipe|econnreset|socket hang up|client (?:is )?closed/i.test(text)
}

/**
 * 判断失败是否属于确定性错误（重试不会成功）。
 * @param text 错误信息与子进程输出
 * @returns 是否为确定性失败
 */
function isPermanentFailure(text: string): boolean {
  return /enoent|command not found|cannot find|eacces|permission denied/i.test(text)
}

/**
 * 把“错误信息 + 子进程输出”压缩成一句可操作的说明。
 * 优先指出限流状态，其次给出子进程最后一条错误行，避免把整段 traceback 抛给用户。
 * @param combined 错误信息与脱敏后的子进程输出
 * @param stderrTail 脱敏后的子进程输出
 * @returns 摘要与是否可重试；无有价值信息时返回 undefined
 */
function summarizeFailure(
  combined: string,
  stderrTail: string,
): { text: string; maxAttempts: number } | undefined {
  const rateLimited = /\b429\b|toomanyrequest|too\s*many\s*request/i.test(combined)
  // 命令不存在、权限不足等属于确定性失败，重试没有意义
  const permanent = isPermanentFailure(combined)
  // 限流通常不会在数秒内恢复，只多试一次，避免拖慢响应
  const maxAttempts = rateLimited ? 2 : permanent ? 1 : isRetryable(combined) ? 2 : 1
  const status = rateLimited ? '上游接口限流（HTTP 429），稍后重试' : undefined
  const lastErrorLine = stderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /error|exception|failed|refused|enoent|not found|traceback/i.test(line))
    .pop()
  const parts = [status, lastErrorLine?.slice(0, 220)].filter((part): part is string => Boolean(part))
  if (!parts.length) return maxAttempts > 1 ? { text: '连接中断', maxAttempts } : undefined
  return { text: parts.join('；'), maxAttempts }
}

/**
 * 在超时后中断等待，避免子进程卡住导致请求悬挂。
 * @param promise 待等待的 Promise
 * @param milliseconds 超时时间
 * @returns Promise 结果
 */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`等待 ${milliseconds}ms 仍未完成 MCP 握手`)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 从子进程输出中抹掉配置里的敏感值，避免错误提示泄露令牌。
 * @param text 原始输出
 * @param env 子进程环境变量
 * @returns 脱敏后的文本
 */
function redactSecrets(text: string, env: Record<string, string> | undefined): string {
  let result = text
  for (const value of Object.values(env ?? {})) {
    if (value.length < 8) continue
    result = result.split(value).join('***')
  }
  return result
}

/**
 * 把未知错误转成可读文本。
 * @param error 捕获到的错误
 * @returns 错误信息
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * 等待指定时间。
 * @param milliseconds 等待毫秒数
 * @returns Promise<void>
 */
async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
