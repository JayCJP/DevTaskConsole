import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CronExecutionReader } from './cron-executions.js'
import type { ScheduledTaskClient } from './scheduled-tasks.js'

/**
 * 创建临时工作区根目录，并在其中写入执行记录文件。
 * @param workspaceName 工作区目录名
 * @param contents 执行记录文件内容；传 undefined 表示不创建文件
 * @returns 工作区根目录与任务目录
 */
async function createWorkspace(
  workspaceName: string,
  contents?: string,
): Promise<{ root: string; taskDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'devtask-cron-'))
  const taskDirectory = join(root, workspaceName, 'repo-a')
  await mkdir(join(taskDirectory, '.codebuddy'), { recursive: true })
  if (contents !== undefined) {
    await writeFile(join(taskDirectory, '.codebuddy', 'scheduled_task_executions.json'), contents, 'utf8')
  }
  return { root, taskDirectory }
}

/**
 * 构造桩客户端。
 * @returns 桩方法与实例
 */
function stubClient(): { client: ScheduledTaskClient; listExecutions: ReturnType<typeof vi.fn> } {
  const listExecutions = vi.fn()
  return { client: { listExecutions } as unknown as ScheduledTaskClient, listExecutions }
}

describe('CronExecutionReader', () => {
  it('实例可用时返回 API 数据并标记 source=api', async () => {
    const { root } = await createWorkspace('ws-a')
    const { client, listExecutions } = stubClient()
    listExecutions.mockResolvedValue({
      executions: [
        { id: 'exec-1', taskId: 'task-1', status: 'succeeded', startedAt: 1_700_000_000_000, completedAt: 1_700_000_060_000, runId: 'run-1' },
      ],
      hasMore: false,
    })
    const page = await new CronExecutionReader(root, client).read({
      taskId: 'task-1',
      port: 60201,
      query: {},
    })
    expect(page.source).toBe('api')
    expect(page.executions[0]?.finishedAt).toBe(new Date(1_700_000_060_000).toISOString())
    expect(page.executions[0]?.runId).toBe('run-1')
    expect(page.warning).toBeUndefined()
  })

  it('API 失败时回退本地文件并给出告警', async () => {
    const contents = JSON.stringify({
      executions: [
        { id: 'exec-1', taskId: 'task-1', status: 'failed', startedAt: 1_700_000_000, error: '模型超时' },
        { id: 'exec-2', taskId: 'other', status: 'succeeded', startedAt: 1_700_000_100 },
      ],
    })
    const { root, taskDirectory } = await createWorkspace('ws-a', contents)
    const { client, listExecutions } = stubClient()
    listExecutions.mockRejectedValue(new Error('ECONNREFUSED'))
    const page = await new CronExecutionReader(root, client).read({
      taskId: 'task-1',
      port: 60201,
      taskDirectory,
      query: {},
    })
    expect(page.source).toBe('file')
    expect(page.warning).toContain('ECONNREFUSED')
    expect(page.executions).toHaveLength(1)
    expect(page.executions[0]?.status).toBe('failed')
    // 秒级时间戳按秒解释，不能被当成 1970 年的毫秒
    expect(page.executions[0]?.startedAt).toBe(new Date(1_700_000_000 * 1000).toISOString())
  })

  it('没有端口时直接读取本地文件', async () => {
    const contents = JSON.stringify([
      { id: 'exec-1', taskId: 'task-1', status: 'succeeded', startedAt: '2026-11-14T02:00:00.000Z' },
    ])
    const { root, taskDirectory } = await createWorkspace('ws-a', contents)
    const { client, listExecutions } = stubClient()
    const page = await new CronExecutionReader(root, client).read({ taskId: 'task-1', taskDirectory, query: {} })
    expect(listExecutions).not.toHaveBeenCalled()
    expect(page.executions[0]?.startedAt).toBe('2026-11-14T02:00:00.000Z')
  })

  it('按状态与时间范围过滤并按开始时间倒序', async () => {
    const contents = JSON.stringify({
      executions: [
        { id: 'exec-1', taskId: 'task-1', status: 'failed', startedAt: 1_700_000_000_000 },
        { id: 'exec-2', taskId: 'task-1', status: 'failed', startedAt: 1_700_000_500_000 },
        { id: 'exec-3', taskId: 'task-1', status: 'succeeded', startedAt: 1_700_000_900_000 },
      ],
    })
    const { root, taskDirectory } = await createWorkspace('ws-a', contents)
    const { client } = stubClient()
    const page = await new CronExecutionReader(root, client).read({
      taskId: 'task-1',
      taskDirectory,
      query: { status: 'failed', from: 1_700_000_100_000 },
    })
    expect(page.executions.map((execution) => execution.id)).toEqual(['exec-2'])
  })

  it('文件缺失或损坏时返回空列表并说明原因', async () => {
    const { root, taskDirectory } = await createWorkspace('ws-a')
    const { client } = stubClient()
    const missing = await new CronExecutionReader(root, client).read({ taskId: 'task-1', taskDirectory, query: {} })
    expect(missing.executions).toEqual([])
    expect(missing.warning).toContain('不存在')

    const broken = await createWorkspace('ws-b', '{not json')
    const corrupt = await new CronExecutionReader(broken.root, client).read({
      taskId: 'task-1',
      taskDirectory: broken.taskDirectory,
      query: {},
    })
    expect(corrupt.executions).toEqual([])
    expect(corrupt.warning).toContain('合法 JSON')
  })

  it('拒绝读取工作区根目录之外的文件', async () => {
    const outside = await createWorkspace('outside')
    const inside = await createWorkspace('inside')
    const { client } = stubClient()
    const page = await new CronExecutionReader(inside.root, client).read({
      taskId: 'task-1',
      taskDirectory: outside.taskDirectory,
      query: {},
    })
    expect(page.executions).toEqual([])
    expect(page.warning).toContain('不存在')
  })

  it('分页大小收敛到 1–100', async () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      id: `exec-${index}`,
      taskId: 'task-1',
      status: 'succeeded',
      startedAt: 1_700_000_000_000 + index * 1000,
    }))
    const { root, taskDirectory } = await createWorkspace('ws-a', JSON.stringify(records))
    const { client } = stubClient()
    const page = await new CronExecutionReader(root, client).read({
      taskId: 'task-1',
      taskDirectory,
      query: { limit: 500 },
    })
    expect(page.executions).toHaveLength(5)
    expect(page.hasMore).toBe(false)
  })
})
