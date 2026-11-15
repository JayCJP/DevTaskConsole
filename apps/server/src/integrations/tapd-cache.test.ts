import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '@devtask/shared'
import { TapdAdapter } from './tapd.js'

const requiredTools = ['get_stories_or_tasks', 'get_related_bugs', 'get_bug', 'get_iterations']
const listing = {
  tools: requiredTools.map((name) => ({
    name,
    inputSchema: { type: 'object' as const, properties: {} },
  })),
}

/** TAPD 侧的需求数据（按 ID 索引） */
const tapdStories: Record<string, { name: string; status: string; owner: string }> = {
  1001: { name: 'TAPD 标题 A', status: 'status_4', owner: '蔡杰鹏;' },
  1002: { name: 'TAPD 标题 B', status: 'status_9', owner: '蔡杰鹏;' },
}

/**
 * 构造一个按请求 ID 返回需求的 TAPD 替身，并统计调用次数。
 * @returns 适配器与调用计数器
 */
function createAdapter(): { adapter: TapdAdapter; calls: string[] } {
  const calls: string[] = []
  const adapter = new TapdAdapter({
    listTools: async () => listing,
    callTool: async (_serverName, name, args) => {
      calls.push(name)
      if (name === 'get_related_bugs') {
        return { content: [{ type: 'text', text: JSON.stringify({ data: [], count: 0 }) }] }
      }
      const options = (args as { options?: { id?: string } }).options
      const ids = (options?.id ?? '').split(',').filter(Boolean)
      const data = ids.map((id) => ({
        Story: { id, ...(tapdStories[id] ?? { name: `Story ${id}`, status: 'status_1', owner: '蔡杰鹏;' }) },
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ data, count: data.length }) }] }
    },
  })
  return { adapter, calls }
}

const requirement: Requirement = { storyId: 'HARNESS-1', title: '本地标题', tapdStoryId: '1001' }

afterEach(() => {
  vi.useRealTimers()
})

describe('TAPD enrichment cache', () => {
  it('reuses cached fields within the TTL and refreshes on force', async () => {
    const { adapter, calls } = createAdapter()

    const first = await adapter.aggregate([requirement])
    expect(first.requirements[0]).toMatchObject({ title: 'TAPD 标题 A', status: 'status_4', owner: '蔡杰鹏;' })
    expect(calls).toEqual(['get_stories_or_tasks', 'get_related_bugs'])
    // 刚拉取的数据不算缓存，不能标成 stale
    expect(first.cachedAt).toBeUndefined()

    const cached = await adapter.aggregate([requirement])
    expect(cached.requirements[0]).toMatchObject({ title: 'TAPD 标题 A' })
    expect(calls).toHaveLength(2)
    expect(cached.cachedAt).toBeTypeOf('string')

    const forced = await adapter.aggregate([requirement], { force: true })
    expect(calls).toHaveLength(4)
    expect(forced.cachedAt).toBeUndefined()
  })

  it('expires the cache after 60 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T00:00:00.000Z'))
    const { adapter, calls } = createAdapter()

    await adapter.aggregate([requirement])
    expect(calls).toHaveLength(2)

    vi.setSystemTime(new Date('2026-11-15T00:00:30.000Z'))
    await adapter.aggregate([requirement])
    expect(calls).toHaveLength(2)

    vi.setSystemTime(new Date('2026-11-15T00:01:01.000Z'))
    await adapter.aggregate([requirement])
    expect(calls).toHaveLength(4)
  })

  it('keeps local requirements as the source of truth while caching TAPD fields', async () => {
    const { adapter, calls } = createAdapter()
    await adapter.aggregate([requirement])

    // 本地新增一个已映射需求：只为它补拉一次，旧需求继续用缓存
    const added = await adapter.aggregate([
      requirement,
      { storyId: 'HARNESS-2', title: '本地标题 B', tapdStoryId: '1002' },
    ])
    expect(added.requirements.map((item) => item.title)).toEqual(['TAPD 标题 A', 'TAPD 标题 B'])
    expect(calls).toHaveLength(4)

    // 本地删除需求：结果里不再出现，也不影响缓存命中
    const removed = await adapter.aggregate([])
    expect(removed).toEqual({ requirements: [], bugs: [] })
  })

  it('never caches failures', async () => {
    let fail = true
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name) => {
        if (fail) throw new Error('TAPD request failed with HTTP 429.')
        const payload = name === 'get_related_bugs'
          ? { data: [], count: 0 }
          : { data: [{ Story: { id: '1001', name: 'TAPD 标题 A', status: 'status_4', owner: '蔡杰鹏;' } }], count: 1 }
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      },
    })

    await expect(adapter.aggregate([requirement])).rejects.toThrow('request failed')
    fail = false
    const recovered = await adapter.aggregate([requirement])
    expect(recovered.requirements[0]).toMatchObject({ title: 'TAPD 标题 A' })
  })
})
