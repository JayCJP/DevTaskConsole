import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CronExecutionPage, Snapshot } from '@devtask/shared'
import { buildServer } from './server.js'
import { AuditLog } from './services/audit-log.js'
import { CronDispatchStore } from './services/cron-dispatch.js'
import { CronMappingStore } from './aggregator/cron-data.js'
import { CodeBuddyApi, CodeBuddyApiError } from './services/codebuddy-api.js'
import { StoryServiceRemoveError, StoryServiceSupervisor } from './services/story-service-supervisor.js'
import type { CronExecutionReader } from './services/cron-executions.js'
import type { ScheduledTaskClient } from './services/scheduled-tasks.js'

const accessToken = 'z'.repeat(64)
let server: ReturnType<typeof buildServer> | undefined
let dataDirectory: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/** 当前用例使用的 Story 服务端口 */
const servicePort = 60299

/**
 * 构造快照：一个已归属 Story 的定时任务。
 * @returns 快照对象
 */
function snapshot(): Snapshot {
  return {
    snapshotAt: '2026-01-01T00:00:00.000Z',
    channels: {},
    requirements: [{ storyId: 'STORY-1', title: 'Requirement', workspacePath: 'work-one/repo-a' }],
    bugs: [],
    harnessBugs: [],
    openQuestions: [],
    harnessActive: [],
    inbox: [],
    jobs: [],
    crons: [{
      id: 'task-1',
      storyId: 'STORY-1',
      storyTitle: 'Requirement',
      cron: '5,25,45 * * * *',
      enabled: true,
      workspacePath: 'work-one/repo-a',
      ownerSessionId: 'session-a',
    }],
    builds: [],
    mergeRequests: [],
  }
}

/**
 * 构造假的服务注册表。
 * @param overrides 覆盖 inspect/stop/remove 行为
 * @returns 桩对象与方法引用
 */
function stubSupervisor(overrides: {
  inspect?: () => Promise<unknown>
  stop?: () => Promise<unknown>
  remove?: () => Promise<unknown>
} = {}): {
  supervisor: StoryServiceSupervisor
  inspect: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const inspect = vi.fn(overrides.inspect ?? (async () => ({
    storyId: 'STORY-1',
    port: servicePort,
    cwd: 'C:/workspaces/work-one/repo-a',
    status: 'running',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })))
  const stop = vi.fn(overrides.stop ?? (async () => ({
    storyId: 'STORY-1',
    port: servicePort,
    cwd: 'C:/workspaces/work-one/repo-a',
    status: 'stopped',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })))
  const remove = vi.fn(overrides.remove ?? (async () => ({
    storyId: 'STORY-1',
    port: servicePort,
    cwd: 'C:/workspaces/work-one/repo-a',
    status: 'stopped',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })))
  const supervisor = {
    inspect,
    stop,
    remove,
    list: vi.fn(async () => []),
    ensureRunning: vi.fn(),
  } as unknown as StoryServiceSupervisor
  return { supervisor, inspect, stop, remove }
}

/**
 * 构造假的定时任务客户端。
 * @param overrides 覆盖默认实现
 * @returns 桩客户端与方法引用
 */
function stubClient(overrides: Partial<Record<string, unknown>> = {}): {
  client: ScheduledTaskClient
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  renew: ReturnType<typeof vi.fn>
  listExecutions: ReturnType<typeof vi.fn>
  listSessionIds: ReturnType<typeof vi.fn>
  resolveSessionId: ReturnType<typeof vi.fn>
  deleteExecutions: ReturnType<typeof vi.fn>
} {
  const list = vi.fn().mockResolvedValue([{ id: 'task-1', cron: '5,25,45 * * * *', enabled: true }])
  const create = vi.fn().mockResolvedValue({ id: 'task-new' })
  const update = vi.fn().mockResolvedValue({ ok: true })
  const remove = vi.fn().mockResolvedValue(undefined)
  const renew = vi.fn().mockResolvedValue({ id: 'task-1', expiresAt: '2026-02-01T00:00:00.000Z' })
  const listExecutions = vi.fn().mockResolvedValue({ executions: [], hasMore: false })
  const listSessionIds = vi.fn().mockResolvedValue(['session-a'])
  const resolveSessionId = vi.fn(async (_port: number, _cwd: string, preferred?: string) => preferred ?? 'session-a')
  const deleteExecutions = vi.fn().mockResolvedValue({ deleted: ['exec-1'], missing: [] })
  const client = {
    list,
    create,
    update,
    remove,
    renew,
    listExecutions,
    listSessionIds,
    resolveSessionId,
    deleteExecutions,
  } as unknown as ScheduledTaskClient
  // 覆盖项直接写回同一对象，保证返回值里的方法引用与 app 实际调用的是同一个桩
  Object.assign(client as unknown as Record<string, unknown>, overrides)
  return {
    client,
    list: (client as unknown as Record<string, ReturnType<typeof vi.fn>>).list as ReturnType<typeof vi.fn>,
    create: (client as unknown as Record<string, ReturnType<typeof vi.fn>>).create as ReturnType<typeof vi.fn>,
    update: (client as unknown as Record<string, ReturnType<typeof vi.fn>>).update as ReturnType<typeof vi.fn>,
    remove: (client as unknown as Record<string, ReturnType<typeof vi.fn>>).remove as ReturnType<typeof vi.fn>,
    renew: (client as unknown as Record<string, ReturnType<typeof vi.fn>>).renew as ReturnType<typeof vi.fn>,
    listExecutions: (client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .listExecutions as ReturnType<typeof vi.fn>,
    listSessionIds: (client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .listSessionIds as ReturnType<typeof vi.fn>,
    resolveSessionId: (client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .resolveSessionId as ReturnType<typeof vi.fn>,
    deleteExecutions: (client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .deleteExecutions as ReturnType<typeof vi.fn>,
  }
}

/**
 * 构造可用的 app，注入桩依赖。
 * @param options 覆盖项
 * @returns app 与桩引用
 */
async function buildApp(options: {
  supervisor?: ReturnType<typeof stubSupervisor>
  client?: ReturnType<typeof stubClient>
  executions?: CronExecutionReader
  api?: CodeBuddyApi
  snapshotProvider?: () => Promise<Snapshot>
} = {}): Promise<{
  app: ReturnType<typeof buildServer>
  supervisor: ReturnType<typeof stubSupervisor>
  client: ReturnType<typeof stubClient>
  mappings: CronMappingStore
  audit: AuditLog
}> {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-cron-routes-'))
  const supervisor = options.supervisor ?? stubSupervisor()
  const client = options.client ?? stubClient()
  const mappings = new CronMappingStore(dataDirectory)
  const audit = new AuditLog(dataDirectory)
  const app = buildServer({
    token: accessToken,
    logger: false,
    snapshotProvider: options.snapshotProvider ?? (async () => snapshot()),
    storyServiceSupervisor: supervisor.supervisor,
    scheduledTaskClient: client.client,
    cronMappingStore: mappings,
    cronDispatchStore: new CronDispatchStore(dataDirectory),
    auditLog: audit,
    ...(options.executions ? { cronExecutionReader: options.executions } : {}),
    ...(options.api ? { codeBuddyApi: options.api } : {}),
  })
  server = app
  return { app, supervisor, client, mappings, audit }
}

/** 带令牌的请求头 */
const headers = { 'x-devtask-token': accessToken }

describe('cron control API', () => {
  it('拒绝分钟位落在 0/30 分的新建请求', async () => {
    const { app, client } = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/crons',
      headers,
      payload: { storyId: 'STORY-1', cron: '*/20 * * * *', prompt: '检查缺陷' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'CRON_EXPRESSION_INVALID' } })
    expect(client.create).not.toHaveBeenCalled()
  })

  it('创建任务时把端口取自 Story 服务并写入审计', async () => {
    const { app, client, audit } = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/crons',
      headers,
      payload: {
        storyId: 'STORY-1',
        cron: '15,45 * * * *',
        prompt: '检查缺陷',
        mode: 'query_only',
        ownerSessionId: 'session-a',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ taskId: 'task-new' })
    expect(client.resolveSessionId).toHaveBeenCalledWith(servicePort, 'C:/workspaces/work-one/repo-a', 'session-a')
    expect(client.create).toHaveBeenCalledWith(servicePort, expect.objectContaining({
      cron: '15,45 * * * *',
      ownerSessionId: 'session-a',
    }))
    const entries = await audit.list()
    expect(entries[0]?.action).toBe('cron.create')
  })

  it('未绑定任务启用和编辑时自动绑定 Story 实例 session', async () => {
    const unbound = snapshot()
    delete unbound.crons[0]?.ownerSessionId
    const { app, client } = await buildApp({ snapshotProvider: async () => unbound })

    const enabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(client.resolveSessionId).toHaveBeenCalledWith(servicePort, 'C:/workspaces/work-one/repo-a', undefined)
    expect(client.update).toHaveBeenCalledWith(servicePort, 'task-1', { enabled: true, ownerSessionId: 'session-a' })

    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { cron: '7 */4 * * *' },
    })
    expect(edited.statusCode).toBe(200)
    expect(client.update).toHaveBeenLastCalledWith(servicePort, 'task-1', {
      cron: '7 */4 * * *',
      ownerSessionId: 'session-a',
    })
  })

  it('Story 未登记服务时返回 409 且不调用上游', async () => {
    const { app, client } = await buildApp({
      supervisor: stubSupervisor({ inspect: async () => undefined }),
    })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { enabled: false },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'STORY_SERVICE_NOT_STARTED' } })
    expect(client.update).not.toHaveBeenCalled()
  })

  it('owner session 不属于该工作区时拒绝保存', async () => {
    const { app, client } = await buildApp({
      client: stubClient({ listSessionIds: vi.fn().mockResolvedValue(['session-b']) }),
    })
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/crons/task-1/mapping',
      headers,
      payload: { storyId: 'STORY-1', ownerSessionId: 'session-x', mode: 'query_fix' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'CRON_OWNER_INVALID' } })
    expect(client.listSessionIds).toHaveBeenCalled()
  })

  it('启停只透传 enabled 并记录为 toggle 审计，可通过撤销回滚', async () => {
    const { app, client, audit } = await buildApp()
    const toggled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { enabled: false },
    })
    expect(toggled.statusCode).toBe(200)
    expect(client.update).toHaveBeenCalledWith(servicePort, 'task-1', { enabled: false, ownerSessionId: 'session-a' })

    const [entry] = await audit.list()
    expect(entry?.action).toBe('cron.toggle')
    expect(entry?.reversible).toBe(true)

    const undo = await app.inject({
      method: 'POST',
      url: `/api/v1/audit/${entry?.id}/undo`,
      headers,
    })
    expect(undo.statusCode).toBe(200)
    expect(client.update).toHaveBeenLastCalledWith(servicePort, 'task-1', { enabled: true, ownerSessionId: 'session-a' })

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/audit/${entry?.id}/undo`,
      headers,
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'AUDIT_ALREADY_UNDONE' } })
  })

  it('删除任务时清理本地映射与轮次登记并标记不可撤销', async () => {
    const { app, client, audit, mappings } = await buildApp()
    await mappings.save({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      mode: 'query_only',
    })
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/crons/task-1',
      headers,
    })
    expect(response.statusCode).toBe(204)
    expect(client.remove).toHaveBeenCalledWith(servicePort, 'task-1', 'session-a')
    expect(await mappings.find('task-1')).toBeUndefined()
    const [entry] = await audit.list()
    expect(entry?.action).toBe('cron.delete')
    expect(entry?.reversible).toBe(false)

    const undo = await app.inject({ method: 'POST', url: `/api/v1/audit/${entry?.id}/undo`, headers })
    expect(undo.statusCode).toBe(409)
    expect(undo.json()).toMatchObject({ error: { code: 'AUDIT_NOT_REVERSIBLE' } })
  })

  it('执行记录优先使用 API，并通过查询参数分页', async () => {
    const page: CronExecutionPage = {
      executions: [{
        id: 'exec-1',
        taskId: 'task-1',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        source: 'api',
        error: '模型超时',
      }],
      hasMore: false,
      source: 'api',
    }
    const read = vi.fn().mockResolvedValue(page)
    const { app } = await buildApp({ executions: { read } as unknown as CronExecutionReader })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/crons/task-1/executions?status=failed&limit=10',
      headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'api', executions: [{ id: 'exec-1' }] })
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      port: servicePort,
      query: expect.objectContaining({ status: 'failed', limit: 10 }),
    }))
  })

  it('派发轮次会创建 Job 并阻断重复派发', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'job-1', sessionId: 'session-a' })
    const { app } = await buildApp({ api: { request } as unknown as CodeBuddyApi })
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/crons/task-1/dispatch',
      headers,
      payload: { label: '第一轮' },
    })
    expect(first.statusCode).toBe(201)
    expect(request).toHaveBeenCalledWith(servicePort, '/api/v1/jobs', 'POST', expect.objectContaining({
      prompt: '/start fixbugs STORY-1',
    }))
    expect(first.json()).toMatchObject({ taskId: 'task-1', state: 'open', jobId: 'job-1' })

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/crons/task-1/dispatch',
      headers,
      payload: {},
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'CRON_DISPATCH_CONFLICT' } })
  })

  it('停服前暂停关联任务，删映射要求已停止', async () => {
    const { app, client, supervisor, mappings } = await buildApp()
    // 关联任务来自显式 owner 映射，停服流程只处理已登记映射的任务
    await mappings.save({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      mode: 'query_only',
    })
    const stopped = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/service/stop',
      headers,
    })
    expect(stopped.statusCode).toBe(200)
    expect(supervisor.stop).toHaveBeenCalledWith('STORY-1')
    expect(client.update).toHaveBeenCalledWith(servicePort, 'task-1', { enabled: false, ownerSessionId: 'session-a' })
    expect(stopped.json()).toMatchObject({ status: 'stopped', pausedTasks: ['task-1'] })

    const removing = await buildApp({
      supervisor: stubSupervisor({
        remove: async () => { throw new StoryServiceRemoveError('Stop the Story service before removing its mapping.') },
      }),
    })
    const rejected = await removing.app.inject({
      method: 'DELETE',
      url: '/api/v1/stories/STORY-1/service',
      headers,
    })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ error: { code: 'STORY_SERVICE_REMOVE_FAILED' } })
  })

  it('归档轮次先校验归属：别的任务的 roundId 不会被误归档', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'job-1' })
    const { app, audit } = await buildApp({ api: { request } as unknown as CodeBuddyApi })
    const dispatched = await app.inject({
      method: 'POST',
      url: '/api/v1/crons/task-1/dispatch',
      headers,
      payload: {},
    })
    expect(dispatched.statusCode).toBe(201)
    const roundId = dispatched.json<{ roundId: string }>().roundId

    // 用错误的任务 ID 归档：必须 404，且轮次仍是 open（可以原样再次归档）
    const wrongTask = await app.inject({
      method: 'POST',
      url: `/api/v1/crons/task-2/dispatches/${roundId}/archive`,
      headers,
      payload: { outcome: 'succeeded' },
    })
    expect(wrongTask.statusCode).toBe(404)
    expect((await audit.list()).some((entry) => entry.action === 'cron.dispatch.archive')).toBe(false)

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/crons/task-1/dispatches/${roundId}/archive`,
      headers,
      payload: { outcome: 'succeeded' },
    })
    expect(archived.statusCode).toBe(200)
    expect(archived.json()).toMatchObject({ roundId, state: 'archived', outcome: 'succeeded' })
    const [entry] = await audit.list()
    expect(entry?.action).toBe('cron.dispatch.archive')
    expect(entry?.reversible).toBe(false)

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/crons/task-1/dispatches/${roundId}/archive`,
      headers,
      payload: { outcome: 'failed' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'CRON_DISPATCH_ALREADY_ARCHIVED' } })
  })

  it('更新任务时若本地映射不存在则新建，缺一半配置时明确拒绝', async () => {
    const { app, mappings } = await buildApp()
    const incomplete = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { ownerSessionId: 'session-a' },
    })
    expect(incomplete.statusCode).toBe(409)
    expect(incomplete.json()).toMatchObject({ error: { code: 'CRON_MAPPING_INCOMPLETE' } })
    expect(await mappings.find('task-1')).toBeUndefined()

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { ownerSessionId: 'session-a', mode: 'query_only' },
    })
    expect(saved.statusCode).toBe(200)
    expect(await mappings.find('task-1')).toMatchObject({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      mode: 'query_only',
    })
  })

  it('已手动暂停的任务在停服时不会被标记为由停服暂停', async () => {
    const { app, mappings } = await buildApp({
      client: stubClient({ list: vi.fn().mockResolvedValue([{ id: 'task-1', cron: '5,25,45 * * * *', enabled: false }]) }),
    })
    await mappings.save({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      mode: 'query_only',
    })
    const stopped = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/service/stop',
      headers,
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json()).toMatchObject({ pausedTasks: [] })
    expect((await mappings.find('task-1'))?.pausedByServiceStop).toBeUndefined()
  })

  it('停服失败时把刚暂停的任务恢复回去', async () => {
    const { app, client, mappings } = await buildApp({
      supervisor: stubSupervisor({
        stop: async () => { throw new Error('process tree still alive') },
      }),
    })
    await mappings.save({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      mode: 'query_only',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/service/stop',
      headers,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'STORY_SERVICE_STOP_FAILED' } })
    expect(client.update).toHaveBeenLastCalledWith(servicePort, 'task-1', { enabled: true, ownerSessionId: 'session-a' })
    expect((await mappings.find('task-1'))?.pausedByServiceStop).toBe(false)
  })

  it('上游限流与鉴权失败给出可区分的错误码', async () => {
    const rateLimited = await buildApp({
      client: stubClient({ update: vi.fn().mockRejectedValue(new CodeBuddyApiError(429, 'Too many requests.')) }),
    })
    const throttled = await rateLimited.app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { enabled: false },
    })
    expect(throttled.statusCode).toBe(503)
    expect(throttled.json()).toMatchObject({ error: { code: 'CODEBUDDY_RATE_LIMITED' } })

    const unauthorized = await buildApp({
      client: stubClient({ update: vi.fn().mockRejectedValue(new CodeBuddyApiError(401, 'Unauthorized.')) }),
    })
    const rejected = await unauthorized.app.inject({
      method: 'PATCH',
      url: '/api/v1/crons/task-1',
      headers,
      payload: { enabled: false },
    })
    expect(rejected.statusCode).toBe(502)
    expect(rejected.json()).toMatchObject({ error: { code: 'CODEBUDDY_UNAUTHORIZED' } })
  })

  it('按 Story 查询任务时用实时字段覆盖，但保留归属信息', async () => {
    const { app } = await buildApp({
      client: stubClient({
        list: vi.fn().mockResolvedValue([
          { id: 'task-1', cron: '15 * * * *', enabled: false, nextRun: '2026-02-01T00:00:00.000Z' },
          { id: 'task-new', cron: '7 */4 * * *', enabled: true, prompt: '检查缺陷\n第二行' },
        ]),
      }),
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/crons?storyId=STORY-1',
      headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ source: string; tasks: Array<Record<string, unknown>> }>()
    expect(body.source).toBe('api')
    const updated = body.tasks.find((task) => task.id === 'task-1')
    expect(updated).toMatchObject({
      storyId: 'STORY-1',
      ownerSessionId: 'session-a',
      cron: '15 * * * *',
      enabled: false,
    })
    const created = body.tasks.find((task) => task.id === 'task-new')
    expect(created).toMatchObject({ storyId: 'STORY-1', promptFirstLine: '检查缺陷' })
  })
})
