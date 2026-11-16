import { describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '@devtask/shared'
import { SNAPSHOT_CACHE_VERSION, type LocalSegment, type SnapshotCacheFile, type TapdSegment } from './snapshot-cache.js'
import { createCachedSnapshotProvider, type SnapshotBuildOptions, type SnapshotBuildResult, type SnapshotCacheStore } from './snapshot.js'

const root = 'D:\\test-branch'

/** 最小合法快照 */
function emptySnapshot(at = '2026-11-16T00:00:00.000Z'): Snapshot {
  return {
    snapshotAt: at,
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
}

function makeEntry(at = '2026-11-16T00:00:00.000Z'): SnapshotCacheFile {
  const channel = { fetchedAt: at, ok: true, stale: false }
  return {
    version: SNAPSHOT_CACHE_VERSION,
    snapshotAt: at,
    workspacesRoot: root,
    segments: {
      local: {
        fetchedAt: at, channel, requirements: [], harnessBugs: [], openQuestions: [], harnessActive: [],
        workspaces: [], localRootAvailable: true,
      },
      tapd: { fetchedAt: at, channel, enrichment: {} },
    },
  }
}

function makeSegments(): { local: LocalSegment; tapd: TapdSegment } {
  return makeEntry().segments
}

/** 内存缓存替身 */
function memoryCache(initial?: SnapshotCacheFile): SnapshotCacheStore & { data?: SnapshotCacheFile; writes: SnapshotCacheFile[] } {
  const store: SnapshotCacheStore & { data?: SnapshotCacheFile; writes: SnapshotCacheFile[] } = {
    data: initial,
    writes: [],
    read: () => store.data,
    write: async (entry) => { store.data = entry; store.writes.push(entry) },
  }
  return store
}

/** 构造构建器替身：记录调用参数，返回指定结果 */
function fakeBuild(result: SnapshotBuildResult) {
  return vi.fn(async (_root: string, _options: SnapshotBuildOptions) => result)
}

function buildResult(at: string, overrides: Partial<SnapshotBuildResult> = {}): SnapshotBuildResult {
  const segments = makeSegments()
  return {
    snapshot: emptySnapshot(at),
    segments,
    rebuilt: { local: false, tapd: false },
    ...overrides,
  }
}

describe('createCachedSnapshotProvider', () => {
  it('passes cached segments into the build on a normal request', async () => {
    const cached = makeEntry()
    const cache = memoryCache(cached)
    const build = fakeBuild(buildResult('2026-11-16T00:01:00.000Z'))

    const provider = createCachedSnapshotProvider({ workspacesRoot: root, cache, build })
    await provider(false)

    expect(build).toHaveBeenCalledTimes(1)
    expect(build.mock.calls[0][1]).toMatchObject({ force: false })
    expect(build.mock.calls[0][1].cachedLocal).toEqual(cached.segments.local)
    expect(build.mock.calls[0][1].cachedTapd).toEqual(cached.segments.tapd)
    // 全缓存命中且无重建 → 不写盘
    expect(cache.writes).toHaveLength(0)
  })

  it('forces a rebuild and writes the cache on manual refresh', async () => {
    const cache = memoryCache(makeEntry())
    const build = fakeBuild(buildResult('2026-11-16T00:02:00.000Z', {
      rebuilt: { local: true, tapd: true },
    }))

    const provider = createCachedSnapshotProvider({ workspacesRoot: root, cache, build })
    await provider(true)

    expect(build.mock.calls[0][1]).toMatchObject({ force: true })
    expect(cache.writes).toHaveLength(1)
    expect(cache.data?.snapshotAt).toBe('2026-11-16T00:02:00.000Z')
    // 写盘时复位 stale 标记
    expect(cache.data?.segments.local.channel.stale).toBe(false)
  })

  it('writes the cache when there is no cache yet (cold start)', async () => {
    const cache = memoryCache()
    const build = fakeBuild(buildResult('2026-11-16T00:03:00.000Z', {
      rebuilt: { local: true, tapd: true },
    }))

    const provider = createCachedSnapshotProvider({ workspacesRoot: root, cache, build })
    await provider(false)

    expect(build.mock.calls[0][1].cachedLocal).toBeUndefined()
    expect(cache.writes).toHaveLength(1)
  })

  it('keeps the old TAPD segment when the forced rebuild fails', async () => {
    const cached = makeEntry()
    const cache = memoryCache(cached)
    // 模拟 buildSnapshotResult 在 TAPD 失败时回退旧段：返回的 segments.tapd 就是缓存里的旧段
    const fallbackSegments = makeSegments()
    const build = fakeBuild(buildResult('2026-11-16T00:04:00.000Z', {
      segments: fallbackSegments,
      rebuilt: { local: true, tapd: false },
    }))

    const provider = createCachedSnapshotProvider({ workspacesRoot: root, cache, build })
    await provider(true)

    // 构建器收到旧 TAPD 段作为兜底
    expect(build.mock.calls[0][1].cachedTapd).toEqual(cached.segments.tapd)
    // 写回的 TAPD 段仍是旧数据（enrichment 与缓存一致）
    expect(cache.data?.segments.tapd).toEqual(fallbackSegments.tapd)
    expect(cache.writes).toHaveLength(1)
  })

  it('does not throw when the cache write fails', async () => {
    const cache: SnapshotCacheStore = {
      read: () => undefined,
      write: async () => { throw new Error('disk full') },
    }
    const logError = vi.fn()
    const build = fakeBuild(buildResult('2026-11-16T00:05:00.000Z', {
      rebuilt: { local: true, tapd: true },
    }))

    const provider = createCachedSnapshotProvider({ workspacesRoot: root, cache, build, logError })
    const snapshot = await provider(false)

    expect(snapshot.snapshotAt).toBe('2026-11-16T00:05:00.000Z')
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })
})
