import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotSchema } from '@devtask/shared'
import { buildSnapshot } from './snapshot.js'
import { CronMappingStore } from './cron-data.js'

// 必须在被测模块加载前隔离数据目录：
// snapshot.ts 里的 StoryServiceSupervisor 是模块级单例，构造时就读取 DEVTASK_DATA_DIR，
// 若在各用例里才设置环境变量，会误读开发机真实的服务登记（正在运行的实例会让 crons 通道报错）。
vi.hoisted(() => {
  const tempBase = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'
  process.env.DEVTASK_DATA_DIR = `${tempBase}/devtask-snapshot-isolated-${process.pid}`
})

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
    const workspace = join(workspacesRoot, 'feature-x')
    const storyDirectory = join(workspace, '.codebuddy', 'plans', 'STORY-INBOX')
    const statePath = join(storyDirectory, 'e2e-state.json')
    await mkdir(dirname(statePath), { recursive: true })
    // 收件箱以工作区列表为骨架：Story 必须先被工作区认领，才会被提取事项
    await writeFile(join(workspace, 'feature-x.code-workspace'), JSON.stringify({ folders: [{ path: '.' }] }))
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
      // 归属来自工作区流水线，不是从 plans 目录路径反推
      workspaceName: 'feature-x',
      workspacePath: 'feature-x',
      priority: 'high',
    })])
    expect(snapshot.openQuestions.map((question) => question.state)).toEqual([
      'pending_confirmation',
      'confirmed',
    ])
  })

  it('derives inbox ownership from the workspace pipeline rules', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-snapshot-inbox-sync-'))
    process.env.DEVTASK_MCP_CONFIG = join(workspacesRoot, 'missing-mcp.json')
    const workspace = join(workspacesRoot, 'feature-sync')
    await mkdir(workspace, { recursive: true })
    // folders[0] 是流水线锚点：只有它下面的 Story 会被工作区认领
    await writeFile(join(workspace, 'feature-sync.code-workspace'), JSON.stringify({ folders: [{ path: 'repo-a' }] }))

    const primaryDirectory = join(workspace, 'repo-a', '.codebuddy', 'plans', 'STORY-PRIMARY')
    await mkdir(primaryDirectory, { recursive: true })
    await writeFile(join(primaryDirectory, 'e2e-state.json'), JSON.stringify({
      storyId: 'STORY-PRIMARY',
      title: 'Primary requirement',
      phase: 2,
      status: 'blocked',
    }))

    const secondaryDirectory = join(workspace, 'repo-b', '.codebuddy', 'plans', 'STORY-SECONDARY')
    await mkdir(secondaryDirectory, { recursive: true })
    await writeFile(join(secondaryDirectory, 'e2e-state.json'), JSON.stringify({
      storyId: 'STORY-SECONDARY',
      title: 'Secondary requirement',
      phase: 1,
      status: 'running',
    }))
    await writeFile(join(secondaryDirectory, 'open-questions.json'), JSON.stringify({
      questions: [{ id: 'Q-1', question: 'Secondary question?' }],
    }))

    const snapshot = await buildSnapshot(workspacesRoot)

    expect(snapshot.workspacePipelines?.[0]?.story?.requirement.storyId).toBe('STORY-PRIMARY')
    // 一个工作区只认 folders[0] 的 Story：repo-b 的 Story 不进入收件箱
    expect(snapshot.inbox).toEqual([expect.objectContaining({
      kind: 'blocked_job',
      requirementId: 'STORY-PRIMARY',
      workspaceName: 'feature-sync',
      workspacePath: 'feature-sync/repo-a',
    })])
    // 待确认项本身仍被采集，只是没有工作区归属时不进收件箱
    expect(snapshot.openQuestions.map((question) => question.storyId)).toEqual(['STORY-SECONDARY'])
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
