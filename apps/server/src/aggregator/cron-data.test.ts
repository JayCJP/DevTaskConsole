import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Requirement } from '@devtask/shared'
import { CronMappingStore, readLocalCrons } from './cron-data.js'

let workspacesRoot: string | undefined
let dataDirectory: string | undefined

afterEach(async () => {
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  workspacesRoot = undefined
  dataDirectory = undefined
})

describe('local scheduled task aggregation', () => {
  it('requires explicit mode and owner mappings and persists them by task ID', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-cron-workspaces-'))
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-cron-data-'))
    const workspacePath = join(workspacesRoot, 'feature-x')
    const taskDirectory = join(workspacePath, '.codebuddy')
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(join(taskDirectory, 'scheduled_tasks.json'), JSON.stringify({
      tasks: [{
        id: 'task-1',
        cron: '7,27,47 * * * *',
        prompt: 'Check TAPD bugs and repair if found.',
        enabled: true,
        expiresAt: '2026-12-01T00:00:00.000Z',
      }],
    }))
    const requirements: Requirement[] = [{
      storyId: 'STORY-1',
      title: '登录优化',
      phase: 2,
      workspacePath: 'feature-x',
    }]
    const beforeMapping = await readLocalCrons(workspacesRoot, requirements, [])
    expect(beforeMapping.crons[0]).toMatchObject({
      id: 'task-1',
      storyId: 'STORY-1',
      storyTitle: '登录优化',
      enabled: true,
      promptFirstLine: 'Check TAPD bugs and repair if found.',
    })
    expect(beforeMapping.crons[0]?.mode).toBeUndefined()
    expect(beforeMapping.crons[0]?.ownerSessionId).toBeUndefined()

    const mappings = new CronMappingStore(dataDirectory)
    await mappings.save({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'owner-session-1',
      mode: 'query_fix',
    })
    const mapped = await readLocalCrons(workspacesRoot, requirements, await mappings.list())
    expect(mapped.crons[0]).toMatchObject({
      mode: 'query_fix',
      ownerSessionId: 'owner-session-1',
    })
    expect(JSON.parse(await readFile(join(dataDirectory, 'cron-mappings.json'), 'utf8'))).toHaveLength(1)
  })

  it('reports malformed task data instead of silently assigning defaults', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-cron-workspaces-'))
    const taskDirectory = join(workspacesRoot, 'feature-x', '.codebuddy')
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(join(taskDirectory, 'scheduled_tasks.json'), JSON.stringify({ tasks: [{ prompt: 'missing ID and cron' }] }))

    const result = await readLocalCrons(workspacesRoot, [{
      storyId: 'STORY-1',
      title: 'Feature',
      workspacePath: 'feature-x',
    }], [])

    expect(result.crons).toEqual([])
    expect(result.errors).toEqual(['STORY-1: scheduled task 1 has an invalid shape.'])
  })
})
