import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { killProcessTree } from './story-service-supervisor.js'

const execFileAsync = promisify(execFile)

/** herdr 单次调用的默认超时（毫秒）。本地 socket 往返通常 <200ms，这里只兜住挂死的情况 */
const DEFAULT_TIMEOUT_MS = 15_000

/** herdr workspace 标签前缀，用于把一个 Story 的服务反查到它专属的托管工作区 */
const WORKSPACE_LABEL_PREFIX = 'devtask-story:'

/** 环境变量开关名：默认走 herdr，显式设为 `spawn` 时回退内置实现 */
export const HERDR_LAUNCHER_ENV = 'DEVTASK_STORY_LAUNCHER'

/** Story 服务的进程托管方式 */
export type StoryServiceLauncher = 'herdr' | 'spawn'

/** 调用 herdr CLI 并返回响应信封的 `result` 字段；测试可注入替身 */
export type HerdrRunner = (args: string[]) => Promise<unknown>

/** `herdr workspace list` 返回的单个工作区摘要 */
interface HerdrWorkspaceSummary {
  workspace_id: string
  label?: string
}

/** `herdr workspace create` 的 result 结构（已按 0.9.5 实测确认） */
interface HerdrWorkspaceCreated {
  root_pane: { pane_id: string }
  workspace: HerdrWorkspaceSummary
}

/** `herdr pane process-info` 的 result 结构（已按 0.9.5 实测确认） */
interface HerdrPaneProcessInfo {
  process_info: { pane_id: string; shell_pid: number }
}

/** herdr 托管实现对外暴露的两个生命周期函数 */
export interface HerdrStoryLifecycle {
  /**
   * 启动 Story 的服务实例。
   * @param cwd 服务工作目录（Story 工作区绝对路径）
   * @param port 已分配的服务端口
   * @param storyId Story 标识，用于定位专属 workspace
   * @returns 承载该服务的 pane shell 进程号，登记进注册表用于停止与重启判定
   */
  launch: (cwd: string, port: number, storyId: string) => Promise<number>
  /**
   * 停止 Story 的服务实例。
   * @param pid 注册表登记的 pane shell 进程号
   * @param storyId Story 标识；缺省时退化为按进程号杀进程树
   * @returns Promise<void>
   */
  stop: (pid: number, storyId?: string) => Promise<void>
}

/**
 * 生成 Story 专属的 herdr workspace 标签。
 * 标签是停止阶段的唯一反查依据，因此必须稳定且能双向解析。
 * @param storyId Story 标识
 * @returns 形如 `devtask-story:STORY-1` 的标签
 */
export function storyServiceWorkspaceLabel(storyId: string): string {
  return `${WORKSPACE_LABEL_PREFIX}${storyId}`
}

/**
 * 创建默认的 herdr CLI 调用器。
 * herdr 的失败可能以 exit code 0 + 非 JSON 文本出现（例如参数不被接受），
 * 因此这里把「输出无法解析」也当作失败抛错，避免把异常静默当成成功。
 * @param binary herdr 可执行文件名，默认从 PATH 解析
 * @param timeoutMs 单次调用超时，默认 15 秒
 * @returns 解析 `result` 之后的调用器
 */
export function createHerdrRunner(binary = 'herdr', timeoutMs = DEFAULT_TIMEOUT_MS): HerdrRunner {
  return async (args: string[]): Promise<unknown> => {
    let stdout: string
    try {
      /** herdr 的 stdout 是单行 JSON 信封，单次响应远小于 4MiB */
      const result = await execFileAsync(binary, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      stdout = result.stdout
    } catch (error) {
      // 默认托管方式依赖 herdr，失败信息必须直接给出可执行的补救动作
      throw new Error(
        `无法调用 herdr（${messageOf(error)}）。请确认 herdr 已安装并在运行，`
          + `或设置 ${HERDR_LAUNCHER_ENV}=spawn 回退到内置启动方式。`,
        { cause: error },
      )
    }
    const text = stdout.trim()
    if (!text) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      throw new Error(`herdr ${args.join(' ')} returned non-JSON output.`, { cause: error })
    }
    const envelope = parsed as { result?: unknown; error?: unknown }
    if (envelope.error !== undefined) {
      throw new Error(`herdr ${args.join(' ')} failed: ${JSON.stringify(envelope.error)}`)
    }
    return envelope.result
  }
}

/**
 * 拼出 codebuddy serve 的启动命令行。
 * 参数与原内置实现保持一致，保证两种启动方式的对外行为等价。
 * @param port 服务端口
 * @returns 可由 pane 内交互式 shell 直接执行的一行命令
 */
function serveCommand(port: number): string {
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
  ].join(' ')
}

/**
 * 按标签关闭已存在的 herdr workspace。
 * 关闭 workspace 会连带结束 pane 内的整个进程树（已实测），
 * 这与原实现 `taskkill /T /F` 的语义一致。
 * @param runner herdr 调用器
 * @param label workspace 标签
 * @returns 至少关闭了一个 workspace 时返回 true
 */
async function closeWorkspaceByLabel(runner: HerdrRunner, label: string): Promise<boolean> {
  const listed = (await runner(['workspace', 'list'])) as { workspaces?: HerdrWorkspaceSummary[] } | undefined
  const matches = (listed?.workspaces ?? []).filter((item) => item.label === label)
  for (const workspace of matches) {
    await runner(['workspace', 'close', workspace.workspace_id])
  }
  return matches.length > 0
}

/**
 * 基于 herdr 持久 pane 的 Story 服务生命周期实现。
 *
 * 与内置 spawn 实现的语义差异（均已实测确认）：
 * - 返回的 pid 是 pane 的 shell 进程号，而非 codebuddy 进程号；herdr 的
 *   `pane process-info` 只暴露前台进程组，拿不到 pane 内子进程 pid。
 * - 每次 launch 都先关闭旧 workspace 再新建，因此 shell_pid 必然变化，
 *   `ServiceMonitor` 用 pid 变化判断「是否真的重启过」的逻辑继续成立。
 * - 进程挂在 herdr server 上，关闭终端窗口不会带走服务。
 * @param runner herdr 调用器
 * @returns 可直接注入 StoryServiceSupervisor 的生命周期实现
 */
export function createHerdrLifecycle(runner: HerdrRunner): HerdrStoryLifecycle {
  return {
    async launch(cwd: string, port: number, storyId: string): Promise<number> {
      const label = storyServiceWorkspaceLabel(storyId)
      // 先清理旧 workspace：既避免标签重复，也保证新实例拿到新的 shell_pid
      await closeWorkspaceByLabel(runner, label)
      const created = (await runner([
        'workspace',
        'create',
        '--cwd',
        cwd,
        '--label',
        label,
        '--no-focus',
      ])) as HerdrWorkspaceCreated
      const paneId = created?.root_pane?.pane_id
      if (!paneId) throw new Error('herdr workspace create did not return a root pane.')
      // pane run 只保证命令被投递，不保证已开始执行；就绪性由 waitUntilHealthy 兜底
      await runner(['pane', 'run', paneId, serveCommand(port)])
      const info = (await runner(['pane', 'process-info', '--pane', paneId])) as HerdrPaneProcessInfo
      const pid = info?.process_info?.shell_pid
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('herdr pane process-info did not return a usable shell pid.')
      }
      return pid
    },

    async stop(pid: number, storyId?: string): Promise<void> {
      if (storyId) {
        const closed = await closeWorkspaceByLabel(runner, storyServiceWorkspaceLabel(storyId))
        if (closed) return
      }
      // workspace 已不存在（例如被手工关闭）或调用方未提供 storyId：按进程树兜底
      await killProcessTree(pid)
    },
  }
}

/**
 * 解析 Story 服务的进程托管方式。
 *
 * 默认 `herdr`：进程挂在 herdr 常驻 server 的 pane 上，既不会因为关闭终端窗口被带走，
 * 也不会像 Windows 上的 detached 子进程那样弹出独立控制台窗口。
 * 只有显式设置 `DEVTASK_STORY_LAUNCHER=spawn` 才回退到内置的 detached 实现。
 * @param env 环境变量表，测试可注入
 * @returns 选定的托管方式
 */
export function resolveStoryServiceLauncher(env: NodeJS.ProcessEnv = process.env): StoryServiceLauncher {
  return (env[HERDR_LAUNCHER_ENV] ?? '').trim().toLowerCase() === 'spawn' ? 'spawn' : 'herdr'
}

/**
 * 提取错误的可读信息。
 * @param error 任意抛出物
 * @returns 错误信息文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
