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
    const dispatch = await store.reserve({ taskId: 'task-1', storyId: 'STORY-1', jobId: 'job-1', label: '第一轮' })
    expect(dispatch.state).toBe('open')
    expect(dispatch.roundId).toBeTruthy()
    expect((await store.openFor('task-1'))?.roundId).toBe(dispatch.roundId)
  })

  it('存在未归档轮次时阻断重复派发', async () => {
    const store = await createStore()
    await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    await expect(store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })).rejects.toBeInstanceOf(
      CronDispatchConflictError,
    )
    // 不同任务互不影响
    await expect(store.reserve({ taskId: 'task-2', storyId: 'STORY-1' })).resolves.toMatchObject({ state: 'open' })
  })

  it('归档后允许开启新轮次', async () => {
    const store = await createStore()
    const first = await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    const archived = await store.archive(first.roundId, 'succeeded')
    expect(archived).toMatchObject({ state: 'archived', outcome: 'succeeded' })
    expect(await store.openFor('task-1')).toBeUndefined()
    const second = await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    expect(second.roundId).not.toBe(first.roundId)
    expect(await store.list()).toHaveLength(2)
  })

  it('并发预占同一任务时只有一个成功，不会留下孤儿轮次', async () => {
    const store = await createStore()
    const results = await Promise.allSettled([
      store.reserve({ taskId: 'task-1', storyId: 'STORY-1' }),
      store.reserve({ taskId: 'task-1', storyId: 'STORY-1' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: expect.any(CronDispatchConflictError),
    })
    expect(await store.list()).toHaveLength(1)
  })

  it('预占后回填 Job ID，轮次不存在时返回 undefined', async () => {
    const store = await createStore()
    const reserved = await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    expect(reserved.jobId).toBeUndefined()
    await expect(store.attachJob(reserved.roundId, 'job-9')).resolves.toMatchObject({ jobId: 'job-9', state: 'open' })
    await expect(store.attachJob('missing', 'job-9')).resolves.toBeUndefined()
  })

  it('归档不存在的轮次返回 undefined', async () => {
    const store = await createStore()
    expect(await store.archive('missing', 'failed')).toBeUndefined()
  })

  it('删除任务时清理其全部轮次', async () => {
    const store = await createStore()
    const first = await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    await store.archive(first.roundId, 'stopped')
    await store.reserve({ taskId: 'task-1', storyId: 'STORY-1' })
    await store.reserve({ taskId: 'task-2', storyId: 'STORY-1' })

    expect(await store.removeByTask('task-1')).toBe(2)
    expect((await store.list()).map((dispatch) => dispatch.taskId)).toEqual(['task-2'])
    expect(await store.removeByTask('missing')).toBe(0)
  })
})
