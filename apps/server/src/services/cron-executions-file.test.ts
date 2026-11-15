import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronExecutionReader } from './cron-executions.js'

let root: string
/** 任务目录（相对工作区根） */
const taskDirectoryName = 'work-one/repo-a'
/** 执行记录文件路径 */
let executionsPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'devtask-cron-exec-'))
  const taskDirectory = join(root, taskDirectoryName)
  await mkdir(join(taskDirectory, '.codebuddy'), { recursive: true })
  executionsPath = join(taskDirectory, '.codebuddy', 'scheduled_task_executions.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * 生成指定数量的执行记录。
 * @param count 记录条数
 * @returns 文件内容
 */
function executionsFile(count: number): string {
  const records = Array.from({ length: count }, (_, index) => ({
    id: `exec-${index}`,
    taskId: 'task-1',
    status: index % 2 === 0 ? 'succeeded' : 'failed',
    startedAt: Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000,
    completedAt: Date.parse('2026-01-01T00:00:30.000Z') + index * 60_000,
  }))
  // 最新的记录应排在前面，startedAt 越大越新
  return JSON.stringify({ executions: records })
}

describe('CronExecutionReader 本地文件分支', () => {
  it('按偏移量分页并返回可继续的游标', async () => {
    await writeFile(executionsPath, executionsFile(5), 'utf8')
    const reader = new CronExecutionReader(root)

    const first = await reader.read({ taskId: 'task-1', taskDirectory: join(root, taskDirectoryName), query: { limit: 2 } })
    expect(first.source).toBe('file')
    expect(first.executions.map((item) => item.id)).toEqual(['exec-4', 'exec-3'])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBe('2')

    const second = await reader.read({
      taskId: 'task-1',
      taskDirectory: join(root, taskDirectoryName),
      query: { limit: 2, cursor: first.nextCursor },
    })
    expect(second.executions.map((item) => item.id)).toEqual(['exec-2', 'exec-1'])
    expect(second.hasMore).toBe(true)

    const third = await reader.read({
      taskId: 'task-1',
      taskDirectory: join(root, taskDirectoryName),
      query: { limit: 2, cursor: second.nextCursor },
    })
    expect(third.executions.map((item) => item.id)).toEqual(['exec-0'])
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeUndefined()
  })

  it('无法解析的游标退回第一页而不是报错', async () => {
    await writeFile(executionsPath, executionsFile(3), 'utf8')
    const reader = new CronExecutionReader(root)
    const page = await reader.read({
      taskId: 'task-1',
      taskDirectory: join(root, taskDirectoryName),
      query: { limit: 2, cursor: 'upstream-opaque-cursor' },
    })
    expect(page.executions.map((item) => item.id)).toEqual(['exec-2', 'exec-1'])
  })

  it('文件超过上限时跳过解析并给出原因', async () => {
    await writeFile(executionsPath, 'x'.repeat(8 * 1024 * 1024 + 1), 'utf8')
    const reader = new CronExecutionReader(root)
    const page = await reader.read({
      taskId: 'task-1',
      taskDirectory: join(root, taskDirectoryName),
      query: {},
    })
    expect(page.executions).toEqual([])
    expect(page.warning).toContain('过大')
  })
})
