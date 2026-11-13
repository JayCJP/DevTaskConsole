import { randomUUID } from 'node:crypto'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getDataDirectory } from '../security/token-store.js'

export type StoryServiceStatus = 'starting' | 'running' | 'failed'

export interface StoryService {
  storyId: string
  port: number
  cwd: string
  pid?: number
  status: StoryServiceStatus
  updatedAt: string
  error?: string
}

interface StoryServiceSupervisorOptions {
  dataDirectory?: string
  portStart?: number
  portEnd?: number
  launch?: (cwd: string, port: number) => Promise<number>
  isPortAvailable?: (port: number) => Promise<boolean>
  isHealthy?: (port: number) => Promise<boolean>
  wait?: (milliseconds: number) => Promise<void>
  retryWait?: (milliseconds: number) => Promise<void>
  startupTimeoutMs?: number
}

export class StoryServiceSupervisor {
  private readonly filePath: string
  private readonly portStart: number
  private readonly portEnd: number
  private readonly launch: (cwd: string, port: number) => Promise<number>
  private readonly isPortAvailable: (port: number) => Promise<boolean>
  private readonly isHealthy: (port: number) => Promise<boolean>
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly retryWait: (milliseconds: number) => Promise<void>
  private readonly startupTimeoutMs: number
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
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
  }

  async recoverPersistedServices(workspacesRoot: string): Promise<void> {
    const services = await this.readRegistry()
    const retryDelays = [5_000, 15_000, 30_000]
    for (const service of services) {
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

  async inspect(storyId: string): Promise<StoryService | undefined> {
    return this.serialize(async () => {
      const services = await this.readRegistry()
      const service = services.find((item) => item.storyId === storyId)
      if (!service) return undefined
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
        const pid = await this.launch(service.cwd, service.port)
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

async function checkHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { 'X-CodeBuddy-Request': '1' },
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    })
    return response.ok
  } catch {
    return false
  }
}

function isStoryService(value: unknown): value is StoryService {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.storyId === 'string'
    && Number.isInteger(item.port)
    && typeof item.cwd === 'string'
    && (item.pid === undefined || Number.isInteger(item.pid))
    && (item.status === 'starting' || item.status === 'running' || item.status === 'failed')
    && typeof item.updatedAt === 'string'
    && (item.error === undefined || typeof item.error === 'string')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
