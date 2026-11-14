import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { snapshotSchema } from '@devtask/shared'
import { buildSnapshot } from './snapshot.js'
import { CronMappingStore } from './cron-data.js'

let workspacesRoot: string | undefined
let dataDirectory: string | undefined
const previousConfigPath = process.env.DEVTASK_MCP_CONFIG
const previousDataDirectory = process.env.DEVTASK_DATA_DIR

afterEach(async () => {
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  if (previousConfigPath === undefined) delete process.env.DEVTASK_MCP_CONFIG
  else process.env.DEVTASK_MCP_CONFIG = previousConfigPath
  if (previousDataDirectory === undefined) delete process.env.DEVTASK_DATA_DIR
  else process.env.DEVTASK_DATA_DIR = previousDataDirectory
  workspacesRoot = undefined
  dataDirectory = undefined
})

describe('snapshot schema tolerance', () => {
  it('accepts upstream timestamps that carry a timezone offset', () => {
    const snapshot = {
      snapshotAt: '2026-11-14T00:00:00.000Z',
      channels: {},
      requirements: [],
      bugs: [],
      harnessBugs: [],
      openQuestions: [],
      harnessActive: [],
      inbox: [],
      jobs: [],
      crons: [],
      builds: [{ id: '1', app: 'web', succeed: true, buildDate: '2026-11-14T09:33:11+08:00' }],
      branches: [{ app: 'web', name: 'origin/dev', lastCommitTime: '2026-11-14T09:33:11+08:00' }],
      mergeRequests: [{
        projectId: 1,
        id: '2',
        title: 'MR',
        sourceBranch: 'feat/x',
        targetBranch: 'dev',
        state: 'merged',
        mergedAt: '2026-11-11T12:16:22.144+08:00',
      }],
    }

    expect(snapshotSchema.safeParse(snapshot).success).toBe(true)
  })
})

describe('snapshot channel status', () => {
  it('distinguishes configured read channels from channels with no MCP configuration', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-snapshot-'))
    process.env.DEVTASK_MCP_CONFIG = join(workspacesRoot, 'missing-mcp.json')

    const snapshot = await buildSnapshot(workspacesRoot)

    expect(snapshot.channels.localHarness).toMatchObject({ ok: true, stale: false })
    expect(snapshot.channels.gitlab).toMatchObject({ ok: false, fetchedAt: null, error: 'GitLab is not configured.' })
    expect(snapshot.channels.devops).toMatchObject({ ok: false, fetchedAt: null, error: 'DevOps is not configured.' })
    expect(snapshot.channels.tapd).toMatchObject({ ok: false, error: 'TAPD is not configured.' })
  })

  it('surfaces pending Harness questions without treating deprecated resolved flags as confirmation', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-snapshot-inbox-'))
    process.env.DEVTASK_MCP_CONFIG = join(workspacesRoot, 'missing-mcp.json')
    const storyDirectory = join(workspacesRoot, 'feature-x', '.codebuddy', 'plans', 'STORY-INBOX')
    const statePath = join(storyDirectory, 'e2e-state.json')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify({
      storyId: 'STORY-INBOX',
      title: 'Inbox requirement',
      phase: 1,
      status: 'running',
    }))
    await writeFile(join(storyDirectory, 'open-questions.json'), JSON.stringify({
      questions: [
        { id: 'Q-1', question: 'Needs an answer?', resolved: true, resolution: 'Draft only' },
        { id: 'Q-2', question: 'Already confirmed?', resolution: 'Yes', confirmation: { answer: 'Yes', confirmedVia: 'accept', confirmedAt: '2026-01-01T00:00:00Z' } },
      ],
    }))

    const snapshot = await buildSnapshot(workspacesRoot)

    expect(snapshot.inbox).toEqual([expect.objectContaining({
      kind: 'open_question',
      title: 'Needs an answer?',
      requirementId: 'STORY-INBOX',
      // 收件箱按「工作区 → Story」分组依赖该字段，缺失会导致事项落进兜底分组
      workspacePath: 'feature-x',
      priority: 'high',
    })])
    expect(snapshot.openQuestions.map((question) => question.state)).toEqual([
      'pending_confirmation',
      'confirmed',
    ])
  })

  it('joins local scheduled tasks with explicit owner and mode mappings', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-snapshot-cron-'))
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-snapshot-cron-data-'))
    process.env.DEVTASK_DATA_DIR = dataDirectory
    process.env.DEVTASK_MCP_CONFIG = join(workspacesRoot, 'missing-mcp.json')
    const workspace = join(workspacesRoot, 'feature-cron')
    const plansDirectory = join(workspace, '.codebuddy', 'plans', 'STORY-CRON')
    await mkdir(plansDirectory, { recursive: true })
    await writeFile(join(plansDirectory, 'e2e-state.json'), JSON.stringify({
      storyId: 'STORY-CRON',
      title: 'Scheduled requirement',
      phase: 1,
      status: 'running',
    }))
    await writeFile(join(workspace, '.codebuddy', 'scheduled_tasks.json'), JSON.stringify({
      tasks: [{ id: 'task-cron', cron: '13 * * * *', prompt: 'Check the TAPD bugs.' }],
    }))
    await new CronMappingStore(dataDirectory).save({
      taskId: 'task-cron',
      storyId: 'STORY-CRON',
      ownerSessionId: 'cron-owner-session',
      mode: 'query_only',
    })

    const snapshot = await buildSnapshot(workspacesRoot)

    expect(snapshot.crons).toEqual([expect.objectContaining({
      id: 'task-cron',
      storyId: 'STORY-CRON',
      storyTitle: 'Scheduled requirement',
      ownerSessionId: 'cron-owner-session',
      mode: 'query_only',
    })])
    expect(snapshot.channels.crons).toMatchObject({ ok: true, stale: false })
  })
})
