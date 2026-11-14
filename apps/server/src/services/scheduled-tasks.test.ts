import { describe, expect, it, vi } from 'vitest'
import { CodeBuddyApi, CodeBuddyApiError } from './codebuddy-api.js'
import { ScheduledTaskClient } from './scheduled-tasks.js'

/**
 * 构造带桩 request 的 CodeBuddyApi，用于断言路径与请求体。
 * @param result 请求返回值
 * @returns 桩对象与调用记录
 */
function stubApi(result: unknown): { api: CodeBuddyApi; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn().mockResolvedValue(result)
  return { api: { request: call } as unknown as CodeBuddyApi, call }
}

describe('ScheduledTaskClient', () => {
  it('列出任务时编码 sessionId 并归一 cron/schedule 两种字段', async () => {
    const { api, call } = stubApi({
      data: {
        tasks: [
          { id: 'task-1', cron: '15,45 * * * *', prompt: '检查缺陷', enabled: true },
          { id: 'task-2', schedule: '15 * * * *', nextRun: 1_700_000_000_000 },
        ],
      },
    })
    const client = new ScheduledTaskClient(api)
    const tasks = await client.list(60201, { sessionId: 'session-a' })
    expect(call).toHaveBeenCalledWith(60201, '/api/v1/scheduled-tasks?sessionId=session-a', 'GET')
    expect(tasks).toHaveLength(2)
    expect(tasks[1]?.cron).toBe('15 * * * *')
    expect(tasks[1]?.nextRun).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('任务列表形状非法时抛 502', async () => {
    const { api } = stubApi({ data: 'oops' })
    await expect(new ScheduledTaskClient(api).list(60201)).rejects.toBeInstanceOf(CodeBuddyApiError)
  })

  it('创建任务只透传显式提供的字段', async () => {
    const { api, call } = stubApi({ id: 'task-new' })
    await new ScheduledTaskClient(api).create(60201, {
      storyId: '1138000000000000001',
      cron: '15,45 * * * *',
      prompt: '检查',
      durable: true,
      ownerSessionId: 'session-a',
    })
    expect(call).toHaveBeenCalledWith(60201, '/api/v1/scheduled-tasks', 'POST', {
      cron: '15,45 * * * *',
      prompt: '检查',
      durable: true,
      sessionId: 'session-a',
    })
  })

  it('更新任务时把 ownerSessionId 映射为 sessionId 并保留 enabled', async () => {
    const { api, call } = stubApi({ ok: true })
    await new ScheduledTaskClient(api).update(60201, 'task-1', { enabled: false, ownerSessionId: 'session-a' })
    expect(call).toHaveBeenCalledWith(60201, '/api/v1/scheduled-tasks/task-1', 'PATCH', {
      enabled: false,
      sessionId: 'session-a',
    })
  })

  it('删除任务带 sessionId 查询参数', async () => {
    const { api, call } = stubApi(undefined)
    await new ScheduledTaskClient(api).remove(60201, 'task-1', 'session-a')
    expect(call).toHaveBeenCalledWith(60201, '/api/v1/scheduled-tasks/task-1?sessionId=session-a', 'DELETE')
  })

  it('查询执行记录时编码全部过滤条件', async () => {
    const { api, call } = stubApi({
      data: {
        executions: [
          { id: 'exec-1', taskId: 'task-1', status: 'failed', startedAt: 1_700_000_000_000, runId: 'run-1' },
        ],
        nextCursor: 'cursor-2',
        hasMore: true,
      },
    })
    const page = await new ScheduledTaskClient(api).listExecutions(60201, 'task-1', {
      status: 'failed',
      from: 1,
      to: 2,
      query: 'run',
      cursor: 'cursor-1',
      limit: 10,
    })
    const target = call.mock.calls[0]?.[1] as string
    expect(target).toContain('/api/v1/scheduled-tasks/task-1/executions?')
    expect(target).toContain('status=failed')
    expect(target).toContain('limit=10')
    expect(target).toContain('cursor=cursor-1')
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('cursor-2')
    expect(page.executions[0]?.runId).toBe('run-1')
  })

  it('单条执行记录形状异常时跳过而不是整体失败', async () => {
    const { api } = stubApi({
      data: { executions: [{ id: 'exec-1' }, { id: 'exec-2', taskId: 'task-1', status: 'succeeded', startedAt: 1 }] },
    })
    const page = await new ScheduledTaskClient(api).listExecutions(60201, 'task-1')
    expect(page.executions.map((execution) => execution.id)).toEqual(['exec-2'])
  })

  it('批量删除执行记录提交 executionIds 数组', async () => {
    const { api, call } = stubApi({ deleted: ['exec-1'], missing: [] })
    await new ScheduledTaskClient(api).deleteExecutions(60201, 'task-1', ['exec-1'])
    expect(call).toHaveBeenCalledWith(
      60201,
      '/api/v1/scheduled-tasks/task-1/executions/delete',
      'POST',
      { executionIds: ['exec-1'] },
    )
  })

  it('列出会话 ID 用于 owner 校验', async () => {
    const { api, call } = stubApi({ data: { sessions: [{ id: 'session-a' }, { id: 'session-b' }] } })
    const ids = await new ScheduledTaskClient(api).listSessionIds(60201, 'D:/workspace/repo')
    expect(call.mock.calls[0]?.[1]).toBe('/api/v1/sessions?cwd=D%3A%2Fworkspace%2Frepo')
    expect(ids).toEqual(['session-a', 'session-b'])
  })
})
