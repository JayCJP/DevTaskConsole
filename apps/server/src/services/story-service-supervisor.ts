import { randomUUID } from 'node:crypto'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getDataDirectory } from '../security/token-store.js'

/**
 * Story 服务状态。
 * `stopped` 表示由控制台主动停止：进程树已结束且端口已释放，
 * 恢复流程不会把它当作需要重启的服务。
 */
export type StoryServiceStatus = 'starting' | 'running' | 'failed' | 'stopped'

export interface StoryService {
  storyId: string
  port: number
  cwd: string
  pid?: number
  status: StoryServiceStatus
  updatedAt: string
  error?: string
}

/** 服务无法停止时的错误：端口仍被占用或无法定位进程 */
export class StoryServiceStopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoryServiceStopError'
  }
}

/** 服务映射无法删除时的错误 */
export class StoryServiceRemoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoryServiceRemoveError'
  }
}

interface StoryServiceSupervisorOptions {
  dataDirectory?: string
  portStart?: number
  portEnd?: number
  /** 启动实现；第三个参数为 Story 标识，供 herdr 等外部托管方式定位专属工作区 */
  launch?: (cwd: string, port: number, storyId: string) => Promise<number>
  isPortAvailable?: (port: number) => Promise<boolean>
  isHealthy?: (port: number) => Promise<boolean>
  wait?: (milliseconds: number) => Promise<void>
  retryWait?: (milliseconds: number) => Promise<void>
  startupTimeoutMs?: number
  /** 结束进程树的实现；默认 Windows 用 taskkill /T /F，其它平台用负 PID 分组信号 */
  killProcessTree?: (pid: number, storyId?: string) => Promise<void>
  /** 停止后等待端口释放的超时时间 */
  stopTimeoutMs?: number
}

export class StoryServiceSupervisor {
  private readonly filePath: string
  private readonly portStart: number
  private readonly portEnd: number
  private readonly launch: (cwd: string, port: number, storyId: string) => Promise<number>
  private readonly isPortAvailable: (port: number) => Promise<boolean>
  private readonly isHealthy: (port: number) => Promise<boolean>
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly retryWait: (milliseconds: number) => Promise<void>
  private readonly killProcessTree: (pid: number, storyId?: string) => Promise<void>
  private readonly startupTimeoutMs: number
  private readonly stopTimeoutMs: number
  private queue: Promise<void> = Promise.resolve()

  constructor(options: StoryServiceSupervisorOptions = {}) {
    this.filePath = join(options.dataDirectory ?? getDataDirectory(), 'story-services.json')
    this.portStart = options.portStart ?? 60200
    this.portEnd = options.portEnd ?? 65535
    if (
      !Number.isInteger(this.portStart)
      || !Number.isInteger(this.portEnd)
      || this.portStart < 1
      || this.portEnd > 65535
      || this.portStart > this.portEnd
    ) {
      throw new Error('Story service port range must be valid and end at or below 65535.')
    }
    this.launch = options.launch ?? launchCodeBuddy
    this.isPortAvailable = options.isPortAvailable ?? portIsAvailable
    this.isHealthy = options.isHealthy ?? checkHealth
    this.wait = options.wait ?? delay
    this.retryWait = options.retryWait ?? delay
    this.killProcessTree = options.killProcessTree ?? killProcessTree
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000
  }

  /**
   * 服务重启后恢复已登记的服务。
   * 被控制台主动停止（status = stopped）的服务不会自动重启，避免覆盖用户意图。
   * @param workspacesRoot 工作区根目录
   * @returns Promise<void>
   */
  async recoverPersistedServices(workspacesRoot: string): Promise<void> {
    const services = await this.readRegistry()
    const retryDelays = [5_000, 15_000, 30_000]
    for (const service of services) {
      if (service.status === 'stopped') continue
      let lastError: unknown
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        const retryDelay = retryDelays[attempt - 1]
        if (retryDelay !== undefined) await this.retryWait(retryDelay)
        try {
          await this.ensureRunning(service.storyId, service.cwd, workspacesRoot)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError !== undefined) {
        await this.markFailed(service.storyId, lastError)
      }
    }
  }

  async list(): Promise<StoryService[]> {
    return this.readRegistry()
  }

  async inspectAll(): Promise<StoryService[]> {
    const services = await this.readRegistry()
    const inspected = await Promise.all(services.map((service) => this.inspect(service.storyId)))
    return inspected.filter((service): service is StoryService => service !== undefined)
  }

  async get(storyId: string): Promise<StoryService | undefined> {
    return (await this.readRegistry()).find((service) => service.storyId === storyId)
  }

  /**
   * 停止 Story 服务：结束整棵进程树并轮询端口释放。
   * 端口未在超时内释放时抛错并保持原登记不变，绝不谎报「已停止」。
   * @param storyId Story 标识
   * @returns 停止后的服务登记（status = stopped）
   */
  async stop(storyId: string): Promise<StoryService> {
    return this.serialize(async () => {
      const services = await this.readRegistry()
      const service = services.find((item) => item.storyId === storyId)
      if (!service) throw new StoryServiceStopError('The Story service is not registered.')
      if (service.status === 'stopped') return service

      if (!(await this.isPortAvailable(service.port))) {
        if (service.pid === undefined) {
          throw new StoryServiceStopError(
            `Port ${service.port} is still in use but no PID is recorded; refusing to report the service as stopped.`,
          )
        }
        await this.killProcessTree(service.pid, service.storyId)
      }
      const released = await this.waitUntilPortReleased(service.port)
      if (!released) {
        throw new StoryServiceStopError(`Port ${service.port} was not released before the stop timeout.`)
      }

      const stopped: StoryService = {
        storyId: service.storyId,
        port: service.port,
        cwd: service.cwd,
        status: 'stopped',
        updatedAt: new Date().toISOString(),
      }
      await this.upsert(services, stopped)
      return stopped
    })
  }

  /**
   * 删除服务映射。只有确认已停止且端口已释放时才允许删除，
   * 避免「映射没了、端口仍被占用」的谎报状态。
   * @param storyId Story 标识
   * @returns 被删除的服务登记
   */
  async remove(storyId: string): Promise<StoryService> {
    return this.serialize(async () => {
      const services = await this.readRegistry()
      const service = services.find((item) => item.storyId === storyId)
      if (!service) throw new StoryServiceRemoveError('The Story service is not registered.')
      if (service.status !== 'stopped') {
        throw new StoryServiceRemoveError('Stop the Story service before removing its mapping.')
      }
      if (!(await this.isPortAvailable(service.port))) {
        throw new StoryServiceRemoveError(`Port ${service.port} is still in use; keeping the mapping.`)
      }
      const next = services.filter((item) => item.storyId !== storyId)
      const directory = dirname(this.filePath)
      await mkdir(directory, { recursive: true })
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporaryPath, this.filePath)
      services.splice(0, services.length, ...next)
      return service
    })
  }

  /**
   * 轮询等待端口释放。
   * @param port 端口号
   * @returns 释放返回 true；超时返回 false
   */
  private async waitUntilPortReleased(port: number): Promise<boolean> {
    const deadline = Date.now() + this.stopTimeoutMs
    while (Date.now() < deadline) {
      if (await this.isPortAvailable(port)) return true
      await this.wait(250)
    }
    return this.isPortAvailable(port)
  }

  async inspect(storyId: string): Promise<StoryService | undefined> {
    return this.serialize(async () => {
      const services = await this.readRegistry()
      const service = services.find((item) => item.storyId === storyId)
      if (!service) return undefined
      // 主动停止的服务不参与健康检查：不响应是预期状态，不能改写成 failed
      if (service.status === 'stopped') return service
      const healthy = await this.isHealthy(service.port)
      const status: StoryServiceStatus = healthy ? 'running' : 'failed'
      const error = healthy ? undefined : 'CodeBuddy service is not responding to health checks.'
      if (service.status === status && service.error === error) return service
      const updated: StoryService = {
        ...service,
        status,
        updatedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      }
      if (healthy) delete updated.error
      await this.upsert(services, updated)
      return updated
    })
  }

  async ensureRunning(storyId: string, cwd: string, workspacesRoot: string): Promise<StoryService> {
    if (!storyId.trim()) throw new Error('Story ID is required.')
    const workspace = await validateWorkspace(cwd, workspacesRoot)
    return this.serialize(async () => {
      const services = await this.readRegistry()
      let service = services.find((item) => item.storyId === storyId)
      if (service && resolve(service.cwd).toLowerCase() !== workspace.toLowerCase()) {
        throw new Error(`Story ${storyId} is already mapped to a different workspace.`)
      }
      if (service && await this.isHealthy(service.port)) {
        if (service.status !== 'running') {
          service = { ...service, status: 'running', updatedAt: new Date().toISOString(), error: undefined }
          await this.upsert(services, service)
        }
        return service
      }

      if (!service) {
        const port = await this.allocatePort(services)
        service = {
          storyId,
          port,
          cwd: workspace,
          status: 'starting',
          updatedAt: new Date().toISOString(),
        }
        await this.upsert(services, service)
      } else {
        service = { ...service, status: 'starting', updatedAt: new Date().toISOString(), error: undefined }
        await this.upsert(services, service)
      }

      try {
        const pid = await this.launch(service.cwd, service.port, service.storyId)
        await this.upsert(services, { ...service, pid, updatedAt: new Date().toISOString() })
        await this.waitUntilHealthy(service.port)
        const running = { ...service, pid, status: 'running' as const, updatedAt: new Date().toISOString() }
        await this.upsert(services, running)
        return running
      } catch (error) {
        const failed: StoryService = {
          ...service,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'CodeBuddy service failed to start.',
        }
        await this.upsert(services, failed)
        throw error
      }
    })
  }

  private async allocatePort(services: StoryService[]): Promise<number> {
    const reserved = new Set(services.map((service) => service.port))
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (!reserved.has(port) && await this.isPortAvailable(port)) return port
    }
    throw new Error(`No free Story service port is available in ${this.portStart}-${this.portEnd}.`)
  }

  private async waitUntilHealthy(port: number): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (await this.isHealthy(port)) return
      await this.wait(250)
    }
    throw new Error(`CodeBuddy service on port ${port} did not become healthy before the startup timeout.`)
  }

  private async readRegistry(): Promise<StoryService[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('Story service registry contains invalid JSON.', { cause: error })
    }
    if (!Array.isArray(value) || !value.every(isStoryService)) {
      throw new Error('Story service registry has an invalid shape.')
    }
    const storyIds = new Set(value.map((service) => service.storyId))
    const ports = new Set(value.map((service) => service.port))
    if (storyIds.size !== value.length || ports.size !== value.length) {
      throw new Error('Story service registry contains duplicate IDs or ports.')
    }
    return value
  }

  private async upsert(current: StoryService[], service: StoryService): Promise<void> {
    const next = [...current.filter((item) => item.storyId !== service.storyId), service]
      .sort((left, right) => left.storyId.localeCompare(right.storyId))
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
    current.splice(0, current.length, ...next)
  }

  private async markFailed(storyId: string, error: unknown): Promise<void> {
    await this.serialize(async () => {
      const services = await this.readRegistry()
      const service = services.find((item) => item.storyId === storyId)
      if (!service) return
      await this.upsert(services, {
        ...service,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'CodeBuddy service recovery failed.',
      })
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise((resolveQueue) => {
      release = resolveQueue
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

async function validateWorkspace(cwd: string, root: string): Promise<string> {
  if (!isAbsolute(cwd) || !isAbsolute(root)) throw new Error('Workspace and root paths must be absolute.')
  assertWorkspaceContained(resolve(cwd), resolve(root))
  const [resolvedRoot, resolvedCwd] = await Promise.all([realpath(resolve(root)), realpath(resolve(cwd))])
  assertWorkspaceContained(resolvedCwd, resolvedRoot)
  return resolvedCwd
}

function assertWorkspaceContained(cwd: string, root: string): void {
  const relativePath = relative(root, cwd)
  if (relativePath === '..' || relativePath.split(/[\\/]/, 1)[0] === '..' || isAbsolute(relativePath)) {
    throw new Error('Story workspace must be inside the configured workspaces root.')
  }
}

function launchCodeBuddy(cwd: string, port: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess
    const args = [
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
    try {
      const windows = process.platform === 'win32'
      const command = windows ? process.env.ComSpec ?? 'cmd.exe' : 'codebuddy'
      const commandArgs = windows
        ? ['/d', '/s', '/c', `codebuddy ${args.join(' ')}`]
        : args
      child = spawnProcess(command, commandArgs, {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      if (child.pid === undefined) reject(new Error('CodeBuddy process did not return a PID.'))
      else resolvePromise(child.pid)
    })
  })
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolvePromise(true))
    })
  })
}

/**
 * 探测 CodeBuddy 实例健康状态。
 * CodeBuddy 在忙碌（正在跑 job）时单次响应可能超过 1 秒，若按 1 秒判死会导致
 * 「健康检查失败 → 触发自动重启」的误报，因此这里给足 2.5 秒并重试一次。
 * @param port 实例端口
 * @returns 健康返回 true
 */
async function checkHealth(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { 'X-CodeBuddy-Request': '1' },
        redirect: 'error',
        signal: AbortSignal.timeout(2500),
      })
      if (response.ok) return true
    } catch {
      // 落入重试：一次超时不代表进程已死
    }
    if (attempt === 0) await delay(200)
  }
  return false
}

function isStoryService(value: unknown): value is StoryService {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.storyId === 'string'
    && Number.isInteger(item.port)
    && typeof item.cwd === 'string'
    && (item.pid === undefined || Number.isInteger(item.pid))
    && (item.status === 'starting' || item.status === 'running' || item.status === 'failed' || item.status === 'stopped')
    && typeof item.updatedAt === 'string'
    && (item.error === undefined || typeof item.error === 'string')
}

/**
 * 结束整棵进程树。
 * Windows 用 `taskkill /T /F`（子进程由 cmd 派生，只有 /T 才能带走整棵树）；
 * 其它平台对负 PID 发 SIGTERM，等价于结束进程组。
 * 进程已退出或命令返回非 0 不算失败，最终以端口是否释放为准。
 * 对外导出是为了让 herdr 等外部托管实现在 pane 已消失时复用同一套兜底逻辑。
 * @param pid 进程 ID
 * @returns Promise<void>
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process ID for Story service stop.')
  await new Promise<void>((resolvePromise, reject) => {
    const windows = process.platform === 'win32'
    const command = windows ? 'taskkill' : 'kill'
    const args = windows ? ['/PID', String(pid), '/T', '/F'] : ['-TERM', `-${pid}`]
    let child: ChildProcess
    try {
      child = spawnProcess(command, args, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('close', () => resolvePromise())
  })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
