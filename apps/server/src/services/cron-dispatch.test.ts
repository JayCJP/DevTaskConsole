import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CronDispatchConflictError, CronDispatchStore } from './cron-dispatch.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/**
 * 创建临时登记表。
 * @returns 登记表实例
 */
async function createStore(): Promise<CronDispatchStore> {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-dispatch-'))
  return new CronDispatchStore(dataDirectory)
}

describe('CronDispatchStore', () => {
  it('登记轮次后 openFor 能查到且状态为 open', async () => {
    const store = await createStore()
    const dispatch = await store.create({ taskId: 'task-1', storyId: 'STORY-1', jobId: 'job-1', label: '第一轮' })
    expect(dispatch.state).toBe('open')
    expect(dispatch.roundId).toBeTruthy()
    expect((await store.openFor('task-1'))?.roundId).toBe(dispatch.roundId)
  })

  it('存在未归档轮次时阻断重复派发', async () => {
    const store = await createStore()
    await store.create({ taskId: 'task-1', storyId: 'STORY-1' })
    await expect(store.create({ taskId: 'task-1', storyId: 'STORY-1' })).rejects.toBeInstanceOf(
      CronDispatchConflictError,
    )
    // 不同任务互不影响
    await expect(store.create({ taskId: 'task-2', storyId: 'STORY-1' })).resolves.toMatchObject({ state: 'open' })
  })

  it('归档后允许开启新轮次', async () => {
    const store = await createStore()
    const first = await store.create({ taskId: 'task-1', storyId: 'STORY-1' })
    const archived = await store.archive(first.roundId, 'succeeded')
    expect(archived).toMatchObject({ state: 'archived', outcome: 'succeeded' })
    expect(await store.openFor('task-1')).toBeUndefined()
    const second = await store.create({ taskId: 'task-1', storyId: 'STORY-1' })
    expect(second.roundId).not.toBe(first.roundId)
    expect(await store.list()).toHaveLength(2)
  })

  it('归档不存在的轮次返回 undefined', async () => {
    const store = await createStore()
    expect(await store.archive('missing', 'failed')).toBeUndefined()
  })

  it('删除任务时清理其全部轮次', async () => {
    const store = await createStore()
    const first = await store.create({ taskId: 'task-1', storyId: 'STORY-1' })
    await store.archive(first.roundId, 'stopped')
    await store.create({ taskId: 'task-1', storyId: 'STORY-1' })
    await store.create({ taskId: 'task-2', storyId: 'STORY-1' })

    expect(await store.removeByTask('task-1')).toBe(2)
    expect((await store.list()).map((dispatch) => dispatch.taskId)).toEqual(['task-2'])
    expect(await store.removeByTask('missing')).toBe(0)
  })
})
