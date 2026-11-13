import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Cron, Requirement } from '@devtask/shared'
import { z } from 'zod'
import { getDataDirectory } from '../security/token-store.js'

const dateTimeSchema = z.string().datetime()

export interface CronTaskMapping {
  taskId: string
  storyId: string
  ownerSessionId: string
  mode: 'query_only' | 'query_fix'
}

export class CronMappingStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'cron-mappings.json')
  }

  async list(): Promise<CronTaskMapping[]> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch (error) {
      throw new Error('Cron mapping file contains invalid JSON.', { cause: error })
    }
    if (!Array.isArray(parsed) || !parsed.every(isCronTaskMapping)) {
      throw new Error('Cron mapping file has an invalid shape.')
    }
    if (new Set(parsed.map((item) => item.taskId)).size !== parsed.length) {
      throw new Error('Cron mapping file contains duplicate task IDs.')
    }
    return parsed
  }

  async save(mapping: CronTaskMapping): Promise<void> {
    await this.serialize(async () => {
      const mappings = await this.list()
      const next = [...mappings.filter((item) => item.taskId !== mapping.taskId), mapping]
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporaryPath, this.filePath)
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise((resolveQueue) => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export async function readLocalCrons(
  workspacesRoot: string,
  requirements: Requirement[],
  mappings: CronTaskMapping[],
): Promise<{ crons: Cron[]; errors: string[] }> {
  const crons: Cron[] = []
  const errors: string[] = []
  const mappingByTask = new Map(mappings.map((mapping) => [mapping.taskId, mapping]))
  const taskIds = new Set<string>()

  for (const requirement of requirements) {
    if (!requirement.workspacePath) continue
    const workspacePath = resolve(workspacesRoot, requirement.workspacePath)
    if (!isInside(workspacesRoot, workspacePath)) {
      errors.push(`${requirement.storyId}: workspace path resolves outside the configured root.`)
      continue
    }
    const tasksPath = join(workspacePath, '.codebuddy', 'scheduled_tasks.json')
    let contents: string
    try {
      const [resolvedRoot, resolvedWorkspace, resolvedTasks] = await Promise.all([
        realpath(workspacesRoot),
        realpath(workspacePath),
        realpath(tasksPath),
      ])
      if (!isInside(resolvedRoot, resolvedWorkspace) || !isInside(resolvedRoot, resolvedTasks)) {
        errors.push(`${requirement.storyId}: scheduled task path resolves outside the configured root.`)
        continue
      }
      contents = await readFile(resolvedTasks, 'utf8')
    } catch (error) {
      if (isMissing(error)) continue
      errors.push(`${requirement.storyId}: unable to read scheduled_tasks.json: ${messageOf(error)}`)
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch (error) {
      errors.push(`${requirement.storyId}: scheduled_tasks.json is invalid JSON: ${messageOf(error)}`)
      continue
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
      errors.push(`${requirement.storyId}: scheduled_tasks.json must contain a tasks array.`)
      continue
    }

    for (const [index, rawTask] of parsed.tasks.entries()) {
      const task = parseTask(rawTask)
      if (!task) {
        errors.push(`${requirement.storyId}: scheduled task ${index + 1} has an invalid shape.`)
        continue
      }
      if (taskIds.has(task.id)) {
        errors.push(`Scheduled task ID ${task.id} appears in more than one workspace.`)
        continue
      }
      taskIds.add(task.id)

      const mapping = mappingByTask.get(task.id)
      if (mapping && mapping.storyId !== requirement.storyId) {
        errors.push(`Scheduled task ${task.id} is explicitly mapped to a different Story.`)
        continue
      }
      const taskMode = task.mode === 'query_only' || task.mode === 'query_fix' ? task.mode : undefined
      crons.push({
        id: task.id,
        storyId: mapping?.storyId ?? requirement.storyId,
        storyTitle: requirement.title,
        cron: task.cron,
        ...(task.enabled !== undefined ? { enabled: task.enabled } : {}),
        ...(mapping?.mode ?? taskMode ? { mode: mapping?.mode ?? taskMode } : {}),
        ...(mapping?.ownerSessionId ? { ownerSessionId: mapping.ownerSessionId } : {}),
        ...(task.nextRun ? { nextRun: task.nextRun } : {}),
        ...(task.expiresAt ? { expiresAt: task.expiresAt } : {}),
        ...(task.prompt ? { promptFirstLine: task.prompt.split(/\r?\n/, 1)[0]?.slice(0, 200) } : {}),
      })
    }
  }
  return { crons, errors }
}

interface ParsedTask {
  id: string
  cron: string
  prompt?: string
  enabled?: boolean
  mode?: string
  nextRun?: string
  expiresAt?: string
}

function parseTask(value: unknown): ParsedTask | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.cron !== 'string'
    || !value.cron.trim()
    || (value.prompt !== undefined && typeof value.prompt !== 'string')
    || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    || (value.mode !== undefined && typeof value.mode !== 'string')
    || !validDate(value.nextRun)
    || !validDate(value.expiresAt)
  ) return undefined
  return {
    id: value.id,
    cron: value.cron,
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    ...(typeof value.nextRun === 'string' ? { nextRun: value.nextRun } : {}),
    ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
  }
}

function validDate(value: unknown): boolean {
  return value === undefined || dateTimeSchema.safeParse(value).success
}

function isCronTaskMapping(value: unknown): value is CronTaskMapping {
  return isRecord(value)
    && typeof value.taskId === 'string'
    && value.taskId.length > 0
    && typeof value.storyId === 'string'
    && value.storyId.length > 0
    && typeof value.ownerSessionId === 'string'
    && value.ownerSessionId.length > 0
    && (value.mode === 'query_only' || value.mode === 'query_fix')
}

function isInside(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const fromRoot = relative(resolve(root), resolve(candidate))
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
