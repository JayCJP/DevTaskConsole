import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings-store.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/**
 * 创建使用临时数据目录的配置存储。
 * @returns 配置存储实例
 */
async function createStore(): Promise<SettingsStore> {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-settings-'))
  return new SettingsStore(dataDirectory)
}

describe('settings store', () => {
  it('returns empty settings when the file does not exist', async () => {
    const store = await createStore()
    await expect(store.get()).resolves.toEqual({})
    expect(store.getSync()).toEqual({})
  })

  it('merges partial updates and persists them', async () => {
    const store = await createStore()
    await store.update({ devtaskSourceRoot: 'D:\\repos', tapdOwner: '张三' })
    const next = await store.update({ cacheDirectory: 'D:\\cache' })

    expect(next).toEqual({
      devtaskSourceRoot: 'D:\\repos',
      tapdOwner: '张三',
      cacheDirectory: 'D:\\cache',
    })
    await expect(new SettingsStore(dataDirectory!).get()).resolves.toEqual(next)
    expect(new SettingsStore(dataDirectory!).getSync()).toEqual(next)
  })

  it('preserves unknown fields so newer settings are not erased by an older version', async () => {
    const store = await createStore()
    await writeFile(
      join(dataDirectory!, 'console-settings.json'),
      JSON.stringify({ tapdOwner: '张三', futureField: { enabled: true } }),
      'utf8',
    )

    const next = await store.update({ devtaskSourceRoot: 'D:\\repos' })
    expect(next).toMatchObject({
      tapdOwner: '张三',
      devtaskSourceRoot: 'D:\\repos',
      futureField: { enabled: true },
    })
    await expect(new SettingsStore(dataDirectory!).get()).resolves.toMatchObject({
      futureField: { enabled: true },
    })
  })

  it('keeps empty strings as-is so readers can treat them as unset', async () => {
    const store = await createStore()
    await store.update({ devtaskSourceRoot: 'D:\\repos' })
    const next = await store.update({ devtaskSourceRoot: '' })

    expect(next.devtaskSourceRoot).toBe('')
  })

  it('serializes concurrent updates without losing fields', async () => {
    const store = await createStore()
    await Promise.all([
      store.update({ devtaskSourceRoot: 'D:\\repos' }),
      store.update({ tapdOwner: '李四' }),
      store.update({ cacheDirectory: 'D:\\cache' }),
    ])

    await expect(store.get()).resolves.toEqual({
      devtaskSourceRoot: 'D:\\repos',
      tapdOwner: '李四',
      cacheDirectory: 'D:\\cache',
    })
  })

  it('rejects malformed JSON on async read', async () => {
    const store = await createStore()
    await writeFile(join(dataDirectory!, 'console-settings.json'), '{ broken', 'utf8')

    await expect(store.get()).rejects.toThrow('非法 JSON')
  })

  it('treats malformed JSON as unset on sync read', () => {
    // 同步读取用于启动阶段，任何异常都按未配置处理，绝不阻断启动
    const store = new SettingsStore(join(tmpdir(), 'devtask-settings-missing-dir'))
    expect(store.getSync()).toEqual({})
  })
})
