import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import {
  workspaceInitializationRequestSchema,
  workspaceInitializationJobSchema,
  type WorkspaceInitializationJob,
  type WorkspaceInitializationRequest,
} from '@devtask/shared'
import { getSourceRoot, listRepositoryCandidates } from './repository-candidates.js'
import { getWorkspacesRoot } from '../aggregator/snapshot.js'
import { getDataDirectory } from '../security/token-store.js'

const scriptPath = join(homedir(), '.codebuddy', 'skills', 'create-workspace', 'scripts', 'create-workspace.ps1')
const maximumLogLines = 5000

interface WorkspaceInitializerOptions {
  dataDirectory?: string
}

export interface WorkspacePreview {
  logs: string[]
  exitCode: number
}

export class WorkspaceInputError extends Error {}
export class WorkspaceDependencyError extends Error {}
export class WorkspaceConflictError extends Error {}

export class WorkspaceInitializer {
  private readonly jobs = new Map<string, WorkspaceInitializationJob>()
  private readonly jobsFilePath: string
  private readonly ready: Promise<void>
  private persistenceQueue: Promise<void> = Promise.resolve()
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: WorkspaceInitializerOptions = {}) {
    this.jobsFilePath = join(options.dataDirectory ?? getDataDirectory(), 'workspace-initialization-jobs.json')
    this.ready = this.loadPersistedJobs()
  }

  async preview(input: unknown): Promise<WorkspacePreview> {
    const request = await this.validate(input)
    const logs: string[] = []
    const exitCode = await this.runPowerShell(buildPowerShellArguments(request, true), (line) => logs.push(line))
    return { logs, exitCode }
  }

  async start(input: unknown): Promise<WorkspaceInitializationJob> {
    await this.ready
    const request = await this.validate(input)
    if ([...this.jobs.values()].some((job) =>
      job.workspaceName === request.workspaceName && job.status === 'running')) {
      throw new WorkspaceConflictError(`Workspace ${request.workspaceName} already has an active initialization job.`)
    }
    const now = new Date().toISOString()
    const job = workspaceInitializationJobSchema.parse({
      id: randomUUID(),
      workspaceName: request.workspaceName,
      status: 'running',
      stage: 'worktree',
      logs: [],
      startedAt: now,
      updatedAt: now,
      exitCode: null,
    })
    this.jobs.set(job.id, job)
    this.pruneCompletedJobs()
    try {
      await this.persistJobs()
    } catch (error) {
      this.jobs.delete(job.id)
      throw error
    }

    try {
      await access(scriptPath)
      const child = spawn('pwsh', buildPowerShellArguments(request, false), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.consumeChild(job, child)
    } catch (error) {
      this.finish(job, 'failed', null, error instanceof Error ? error.message : 'Unable to start PowerShell.')
    }

    return copyJob(job)
  }

  async getJob(id: string): Promise<WorkspaceInitializationJob | undefined> {
    await this.ready
    const job = this.jobs.get(id)
    return job ? copyJob(job) : undefined
  }

  async flush(): Promise<void> {
    await this.ready
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer)
      this.persistenceTimer = undefined
      await this.persistJobs()
      return
    }
    await this.persistenceQueue
  }

  private async loadPersistedJobs(): Promise<void> {
    let contents: string
    try {
      contents = await readFile(this.jobsFilePath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('Workspace initialization job registry contains invalid JSON.', { cause: error })
    }
    const parsed = workspaceInitializationJobSchema.array().safeParse(value)
    if (!parsed.success) throw new Error('Workspace initialization job registry has an invalid shape.')
    for (const job of parsed.data) {
      if (job.status === 'running') {
        job.status = 'interrupted'
        job.stage = 'failed'
        job.exitCode = null
        job.updatedAt = new Date().toISOString()
        addLog(job, 'The server restarted while this job was running; its process state is unknown.')
      }
      this.jobs.set(job.id, job)
    }
    this.pruneCompletedJobs()
    if (parsed.data.some((job) => job.status === 'interrupted')) await this.persistJobs()
  }

  private async persistJobs(): Promise<void> {
    const snapshot = [...this.jobs.values()].map(copyJob)
    const previous = this.persistenceQueue
    let release: () => void = () => {}
    this.persistenceQueue = new Promise((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      await mkdir(dirname(this.jobsFilePath), { recursive: true })
      const temporaryPath = `${this.jobsFilePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporaryPath, this.jobsFilePath)
    } finally {
      release()
    }
  }

  private schedulePersistence(job: WorkspaceInitializationJob): void {
    if (this.persistenceTimer) return
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined
      void this.persistJobs().catch((error: unknown) => {
        addLog(job, `Unable to persist initialization progress: ${error instanceof Error ? error.message : 'unknown error'}`)
        console.error('Unable to persist workspace initialization progress.', error)
      })
    }, 150)
    this.persistenceTimer.unref?.()
  }

  private pruneCompletedJobs(): void {
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    while (this.jobs.size > 50 && completed.length) {
      const oldest = completed.shift()
      if (oldest) this.jobs.delete(oldest.id)
    }
  }

  private async validate(input: unknown): Promise<WorkspaceInitializationRequest> {
    const parsed = workspaceInitializationRequestSchema.safeParse(input)
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; ')
      throw new WorkspaceInputError(`Workspace initialization parameters are invalid: ${details}`)
    }
    const { workspaceName, repositoryNames, branch, baseBranch } = parsed.data
    if (branch?.startsWith('-') || baseBranch?.startsWith('-')) {
      throw new WorkspaceInputError('Branch names must not start with a hyphen.')
    }
    const candidates = await listRepositoryCandidates(getSourceRoot())
    const availableNames = new Set(candidates.map((candidate) => candidate.name))
    const unselectedCandidates = repositoryNames.filter((name) => !availableNames.has(name))
    if (unselectedCandidates.length) {
      throw new WorkspaceInputError(`Selected repositories are no longer available: ${unselectedCandidates.join(', ')}.`)
    }
    try {
      await access(scriptPath)
    } catch (error) {
      throw new WorkspaceDependencyError(`Workspace initialization script is unavailable: ${scriptPath}`, { cause: error })
    }
    return { ...parsed.data, workspaceName }
  }

  private runPowerShell(args: string[], onLine: (line: string) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        child = spawn('pwsh', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        reject(error)
        return
      }

      consumeLines(child.stdout, onLine)
      consumeLines(child.stderr, onLine)
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === null) reject(new Error('PowerShell exited without a status code.'))
        else resolve(code)
      })
    })
  }

  private consumeChild(job: WorkspaceInitializationJob, child: ChildProcessByStdio<null, Readable, Readable>): void {
    consumeLines(child.stdout, (line) => this.recordLog(job, line))
    consumeLines(child.stderr, (line) => this.recordLog(job, line))
    child.once('error', (error) => this.finish(job, 'failed', null, error.message))
    child.once('close', (code) => {
      if (code === 0) {
        job.stage = 'complete'
        this.finish(job, 'succeeded', code)
      } else {
        this.finish(job, 'failed', code, `PowerShell exited with code ${code ?? 'unknown'}.`)
      }
    })
  }

  private finish(
    job: WorkspaceInitializationJob,
    status: 'succeeded' | 'failed',
    exitCode: number | null,
    message?: string,
  ): void {
    if (job.status !== 'running') return
    if (message) addLog(job, message)
    job.status = status
    job.stage = status === 'succeeded' ? 'complete' : 'failed'
    job.exitCode = exitCode
    job.updatedAt = new Date().toISOString()
    this.schedulePersistence(job)
  }

  private recordLog(job: WorkspaceInitializationJob, line: string): void {
    addLog(job, line)
    this.schedulePersistence(job)
  }
}

function buildPowerShellArguments(request: WorkspaceInitializationRequest, dryRun: boolean): string[] {
  const parameters = [
    `-Workspace ${quotePowerShell(request.workspaceName)}`,
    `-Repos ${quotePowerShell(request.repositoryNames.join(','))}`,
    `-SourceRoot ${quotePowerShell(getSourceRoot())}`,
    `-TargetRoot ${quotePowerShell(getWorkspacesRoot())}`,
  ]
  if (request.branch) parameters.push(`-Branch ${quotePowerShell(request.branch)}`)
  if (request.baseBranch) parameters.push(`-BaseBranch ${quotePowerShell(request.baseBranch)}`)
  if (request.skipInstall) parameters.push('-SkipInstall')
  if (request.skipGraphify) parameters.push('-SkipGraphify')
  if (dryRun) parameters.push('-DryRun')
  const command = [
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $utf8',
    `$OutputEncoding = $utf8; & ${quotePowerShell(scriptPath)} ${parameters.join(' ')}; exit $LASTEXITCODE`,
  ].join('; ')
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
  return ['-NoLogo', '-NoProfile', '-EncodedCommand', encodedCommand]
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function consumeLines(stream: Readable, onLine: (line: string) => void): void {
  let remainder = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const lines = `${remainder}${chunk}`.split(/\r?\n/)
    remainder = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  stream.on('end', () => {
    if (remainder) onLine(remainder)
  })
}

function addLog(job: WorkspaceInitializationJob, line: string): void {
  const stage = stageFromLine(line)
  if (stage) job.stage = stage
  if (job.logs.length === maximumLogLines) {
    job.logs.shift()
    if (job.logs[0] !== '[Older output truncated.]') job.logs.unshift('[Older output truncated.]')
  }
  job.logs.push(line)
  job.updatedAt = new Date().toISOString()
}

function stageFromLine(line: string): WorkspaceInitializationJob['stage'] | undefined {
  if (/阶段\s*1\/4/.test(line)) return 'worktree'
  if (/阶段\s*2\/4/.test(line)) return 'workspace_file'
  if (/阶段\s*3\/4|npm install/i.test(line)) return 'install'
  if (/阶段\s*4\/4|graphify/i.test(line)) return 'graphify'
  if (/结果复核/.test(line)) return 'verify'
  return undefined
}

function copyJob(job: WorkspaceInitializationJob): WorkspaceInitializationJob {
  return { ...job, logs: [...job.logs] }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
