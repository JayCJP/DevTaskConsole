import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeTapdStoryId,
  WorkspaceBindingConflictError,
  WorkspaceBindingInputError,
  WorkspaceBindingStore,
} from './bindings.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/**
 * 创建使用临时数据目录的绑定存储。
 * @returns 绑定存储实例
 */
async function createStore(): Promise<WorkspaceBindingStore> {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-workspace-bindings-'))
  return new WorkspaceBindingStore(dataDirectory)
}

describe('workspace binding store', () => {
  it('persists one binding per workspace and per TAPD story', async () => {
    const store = await createStore()

    await store.upsert({ tapdStoryId: '1001', workspaceName: 'feature-x', storyTitle: '需求一' })
    const bindings = await store.upsert({ tapdStoryId: '1002', workspaceName: 'feature-y' })

    expect(bindings).toHaveLength(2)
    await expect(new WorkspaceBindingStore(dataDirectory!).list()).resolves.toMatchObject([
      { tapdStoryId: '1001', workspaceName: 'feature-x', storyTitle: '需求一' },
      { tapdStoryId: '1002', workspaceName: 'feature-y' },
    ])
  })

  it('treats re-saving the same story as an edit and switches its workspace', async () => {
    const store = await createStore()
    await store.upsert({ tapdStoryId: '1001', workspaceName: 'feature-x' })

    const bindings = await store.upsert({ tapdStoryId: '1001', workspaceName: 'feature-y' })

    expect(bindings).toEqual([
      expect.objectContaining({ tapdStoryId: '1001', workspaceName: 'feature-y' }),
    ])
  })

  it('rejects a workspace that is already bound to another story', async () => {
    const store = await createStore()
    await store.upsert({ tapdStoryId: '1001', workspaceName: 'feature-x' })

    await expect(store.upsert({ tapdStoryId: '1002', workspaceName: 'feature-x' }))
      .rejects.toBeInstanceOf(WorkspaceBindingConflictError)
  })

  it('removes an existing binding without touching the others', async () => {
    const store = await createStore()
    await store.upsert({ tapdStoryId: '1001', workspaceName: 'feature-x' })
    await store.upsert({ tapdStoryId: '1002', workspaceName: 'feature-y' })

    const bindings = await store.remove('1001')

    expect(bindings.map((binding) => binding.tapdStoryId)).toEqual(['1002'])
  })
})

describe('TAPD story id normalization', () => {
  it('accepts plain ids and story links', () => {
    expect(normalizeTapdStoryId(' 1138260062001031810 ')).toBe('1138260062001031810')
    expect(normalizeTapdStoryId('https://www.tapd.cn/38260062/prong/stories/view/1138260062001031810'))
      .toBe('1138260062001031810')
    expect(normalizeTapdStoryId('https://www.tapd.cn/38260062/prong/stories/view/1138260062001031810?from=search'))
      .toBe('1138260062001031810')
  })

  it('rejects input without a recognizable id', () => {
    expect(() => normalizeTapdStoryId('   ')).toThrow(WorkspaceBindingInputError)
    expect(() => normalizeTapdStoryId('not-a-story')).toThrow(WorkspaceBindingInputError)
  })
})
