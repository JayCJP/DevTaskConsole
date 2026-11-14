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

  it('reads tasks straight from workspace projects even without a Story', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-cron-workspaces-'))
    const projectPath = join(workspacesRoot, 'feature-x', 'repo-a')
    await mkdir(join(projectPath, '.codebuddy'), { recursive: true })
    await writeFile(join(projectPath, '.codebuddy', 'scheduled_tasks.json'), JSON.stringify({
      tasks: [{ id: 'task-workspace', cron: '0 9 * * *', prompt: 'Scan TAPD bugs.' }],
    }))

    const result = await readLocalCrons(workspacesRoot, [], [], [{
      name: 'feature-x',
      path: join(workspacesRoot, 'feature-x'),
      missingProjects: [],
      projects: [{ name: 'repo-a', path: projectPath, worktree: true }],
    }])

    expect(result.errors).toEqual([])
    expect(result.crons).toEqual([expect.objectContaining({
      id: 'task-workspace',
      workspacePath: 'feature-x/repo-a',
    })])
    // 没有 Story 时不臆造归属，交给项目级展示
    expect(result.crons[0]?.storyId).toBeUndefined()
  })

  it('accepts millisecond timestamps written by CodeBuddy scheduled tasks', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-cron-workspaces-'))
    const projectPath = join(workspacesRoot, 'feature-x', 'repo-a')
    await mkdir(join(projectPath, '.codebuddy'), { recursive: true })
    await writeFile(join(projectPath, '.codebuddy', 'scheduled_tasks.json'), JSON.stringify({
      tasks: [{
        id: 'task-ts',
        cron: '7 */6 * * *',
        enabled: false,
        recurring: true,
        expiryDays: 30,
        expiresAt: 1797124163907,
      }],
    }))

    const result = await readLocalCrons(workspacesRoot, [], [], [{
      name: 'feature-x',
      path: join(workspacesRoot, 'feature-x'),
      missingProjects: [],
      projects: [{ name: 'repo-a', path: projectPath, worktree: true }],
    }])

    expect(result.errors).toEqual([])
    expect(result.crons).toEqual([expect.objectContaining({
      id: 'task-ts',
      enabled: false,
      expiresAt: new Date(1797124163907).toISOString(),
    })])
  })
})
