import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HERDR_LAUNCHER_ENV } from './herdr-story-service.js'

const execFileAsync = promisify(execFile)

/** CLI 单次调用的默认超时（毫秒）：本地 IPC 往返很快，只兜住挂死的情况 */
const DEFAULT_TIMEOUT_MS = 15_000

/** herdr-app 中承载 Story 服务的固定 space 名称 */
const APP_SPACE_NAME = 'devtask-services'

/** 轮询 hc get 取真实进程 pid 的超时（毫秒） */
const PID_READY_TIMEOUT_MS = 10_000

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 250

/** CLI 调用器：接收参数数组，返回解析后的 JSON；测试可注入替身 */
export type CliRunner = (args: string[]) => Promise<unknown>

/**
 * CLI 调用失败时抛出的错误，保留 hc 错误信封的 kind，供调用方区分「终端不存在」与真实故障。
 */
export class CliError extends Error {
  /** hc 错误信封里的种类，如 not_found；herdr-app 的字符串错误没有此字段 */
  readonly kind?: string

  constructor(message: string, kind?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CliError'
    this.kind = kind
  }
}

/**
 * 判断错误是否为「目标不存在」（幂等清理时应当忽略）。
 * @param error 捕获到的错误
 * @returns not_found 返回 true
 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof CliError && error.kind === 'not_found'
}

/** herdr-app `do` 返回的终端创建结果 */
interface AppTerminalCreated {
  space: string
  tab: string
  terminal: string
  error?: string
}

/** herdr-app `ls` 返回的 space 结构（只取需要的字段） */
interface AppSpaceSummary {
  id: string
  name: string
  tabs?: Array<{
    id: string
    name: string
    terminals?: Array<{ terminal: string }>
  }>
}

/** hc get 返回的终端状态（只取需要的字段） */
interface HcTerminalState {
  state?: string
  exit_code?: number | null
  foreground?: { pid?: number }
  error?: { kind?: string; message?: string; hint?: string }
}

/** herdr-app + hc 托管实现对外暴露的两个生命周期函数 */
export interface AppHcStoryLifecycle {
  /**
   * 启动 Story 的服务实例。
   * @param cwd 服务工作目录（Story 工作区绝对路径）
   * @param port 已分配的服务端口
   * @param storyId Story 标识，用作 herdr-app 的 tab 名称
   * @returns 承载该服务的 hc 终端 address（字符串句柄）
   */
  launch: (cwd: string, port: number, storyId: string) => Promise<string>
  /**
   * 停止 Story 的服务实例。
   * @param pid 进程句柄；app-hc 实现下应为 hc 终端 address 字符串，数字句柄则忽略
   * @param _storyId Story 标识（当前实现用不到，保留以匹配注入签名）
   * @returns Promise<void>
   */
  stop: (pid: number | string, _storyId?: string) => Promise<void>
}

/**
 * 创建通用 CLI 调用器。
 *
 * herdr-app / hc 的错误可能以 exit code 0 + stdout 中的 `{error}` 出现，
 * 因此这里把「输出无法解析」和「信封含 error」都当作失败抛错，绝不依赖 exit code。
 *
 * @param binary 可执行文件名，默认从 PATH 解析
 * @param timeoutMs 单次调用超时，默认 15 秒
 * @returns 解析 JSON 之后的调用器
 */
export function createCliRunner(binary: string, timeoutMs = DEFAULT_TIMEOUT_MS): CliRunner {
  return async (args: string[]): Promise<unknown> => {
    let stdout: string
    try {
      const result = await execFileAsync(binary, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      stdout = result.stdout
    } catch (error) {
      throw new Error(
        `无法调用 ${binary}（${messageOf(error)}）。请确认 ${binary} 已安装并可用，` +
          `或设置 ${HERDR_LAUNCHER_ENV}=herdr / spawn 回退到其它启动方式。`,
        { cause: error },
      )
    }
    const text = stdout.trim()
    if (!text) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      throw new Error(`${binary} ${args.join(' ')} returned non-JSON output.`, { cause: error })
    }
    // herdr-app 的 do 命令把错误放在顶层 error 字符串；hc 放在 {error:{kind,message,hint}}
    const envelope = parsed as { error?: unknown }
    if (envelope.error !== undefined) {
      const kind =
        typeof envelope.error === 'object' && envelope.error !== null
          ? (envelope.error as { kind?: unknown }).kind
          : undefined
      throw new CliError(
        `${binary} ${args.join(' ')} failed: ${JSON.stringify(envelope.error)}`,
        typeof kind === 'string' ? kind : undefined,
      )
    }
    return parsed
  }
}

/**
 * 拼出 codebuddy serve 的 argv 数组。
 * 以数组形式经 execFile 传递（不经 shell），避免 JSON 在命令行里被 shell 展开破坏。
 * @param port 服务端口
 * @returns codebuddy 启动参数数组
 */
function serveArgv(port: number): string[] {
  return [
    'codebuddy',
    '--serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--permission-mode',
    'bypassPermissions',
    '--auth',
    'none',
  ]
}

/**
 * 找到（或创建）承载 Story 服务的固定 space。
 * @param appRun herdr-app 调用器
 * @param folder space 的工作目录
 * @returns space id
 */
async function ensureAppSpace(appRun: CliRunner, folder: string): Promise<string> {
  const listed = (await appRun(['ls'])) as { spaces?: AppSpaceSummary[] } | undefined
  const existing = (listed?.spaces ?? []).find((space) => space.name === APP_SPACE_NAME)
  if (existing) return existing.id
  const created = (await appRun([
    'do',
    'space.new',
    '--name',
    APP_SPACE_NAME,
    '--folder',
    folder,
    '--focus',
    'false',
  ])) as AppTerminalCreated
  if (!created?.space) throw new Error('herdr-app space.new did not return a space id.')
  return created.space
}

/**
 * 按 address 结束并移除 hc 终端（kill 后 rm）。
 * 幂等：终端已不存在时 not_found 视为已停止；其它错误（如 CLI 故障）透传。
 * @param hcRun hc 调用器
 * @param address 终端 address
 * @returns Promise<void>
 */
async function killAndRemoveTerminal(hcRun: CliRunner, address: string): Promise<void> {
  for (const command of ['kill', 'rm']) {
    try {
      await hcRun([command, address])
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

/**
 * 关闭同名的旧 terminal（launch 前清理，避免重复 tab 占用端口）。
 * herdr-app 的 tab.new 允许同名，不会自动覆盖旧的，因此必须显式清理。
 * @param hcRun hc 调用器
 * @param address 旧终端 address
 */
async function closeOldTerminal(hcRun: CliRunner, address: string): Promise<void> {
  await killAndRemoveTerminal(hcRun, address)
}

/**
 * 在指定 space 中查找名为 storyId 的 tab 及其 terminal address。
 * @param appRun herdr-app 调用器
 * @param spaceId space id
 * @param storyId Story 标识（tab 名称）
 * @returns 旧 terminal address 列表
 */
async function findOldTerminals(
  appRun: CliRunner,
  spaceId: string,
  storyId: string,
): Promise<string[]> {
  const listed = (await appRun(['ls'])) as { spaces?: AppSpaceSummary[] } | undefined
  const space = (listed?.spaces ?? []).find((item) => item.id === spaceId)
  const addresses: string[] = []
  for (const tab of space?.tabs ?? []) {
    if (tab.name !== storyId) continue
    for (const terminal of tab.terminals ?? []) addresses.push(terminal.terminal)
  }
  return addresses
}

/**
 * 轮询 hc get 直到拿到真实 codebuddy 进程 pid。
 * foreground.pid 在刚启动时可能为空，必须带重试。
 * @param hcRun hc 调用器
 * @param address 终端 address
 * @returns 真实进程 pid
 */
async function waitForForegroundPid(hcRun: CliRunner, address: string): Promise<number> {
  const deadline = Date.now() + PID_READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const state = (await hcRun(['get', address])) as HcTerminalState | undefined
      const pid = state?.foreground?.pid
      if (Number.isInteger(pid) && (pid as number) > 0) return pid as number
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(
    `hc get ${address} 未返回可用的 foreground pid${lastError ? `（${messageOf(lastError)}）` : ''}。`,
  )
}

/**
 * 基于 herdr-app 启动 + hc 查停的 Story 服务生命周期实现。
 *
 * 与 herdr 实现的关系：
 * - launch 返回 hc 终端 address（字符串），每次新建必然变化，满足 ServiceMonitor 的重启判定。
 * - 进程挂在 herdr-core 上，关闭 herdr-app 窗口不会带走服务（桌面常开是启动前提）。
 * - 服务显示在 herdr-app 的 tab 上，tab 名即 storyId，便于人工查看。
 *
 * @param appRun herdr-app 调用器
 * @param hcRun hc 调用器
 * @param folder herdr-app space 的工作目录
 * @returns 可直接注入 StoryServiceSupervisor 的生命周期实现
 */
export function createAppHcLifecycle(
  appRun: CliRunner,
  hcRun: CliRunner,
  folder: string,
): AppHcStoryLifecycle {
  return {
    async launch(cwd: string, port: number, storyId: string): Promise<string> {
      const spaceId = await ensureAppSpace(appRun, folder)

      // 清理同名旧 tab：tab.new 不会覆盖旧实例，必须先关掉，避免重复 tab 占用端口
      const oldAddresses = await findOldTerminals(appRun, spaceId, storyId)
      for (const address of oldAddresses) {
        await closeOldTerminal(hcRun, address)
      }

      const created = (await appRun([
        'do',
        'tab.new',
        '--name',
        storyId,
        '--space',
        spaceId,
        '--folder',
        cwd,
        '--argv',
        JSON.stringify(serveArgv(port)),
      ])) as AppTerminalCreated
      const address = created?.terminal
      if (!address) throw new Error('herdr-app tab.new did not return a terminal address.')

      // 关掉 keep：避免 codebuddy 异常死亡后被 hc 自动换成 shell 干扰状态判定（错误忽略）
      try {
        await hcRun(['keep', address, '--off'])
      } catch {
        // keep 设置失败不影响服务本身，忽略
      }

      await waitForForegroundPid(hcRun, address)
      return address
    },

    async stop(pid: number | string, _storyId?: string): Promise<void> {
      // 只处理字符串句柄（hc 终端 address）；数字句柄不属于本实现
      if (typeof pid !== 'string') return
      await killAndRemoveTerminal(hcRun, pid)
    },
  }
}

/**
 * 提取错误的可读信息。
 * @param error 任意抛出物
 * @returns 错误信息文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
