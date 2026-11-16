import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_CACHE_VERSION, SnapshotCache, type SnapshotCacheFile } from './snapshot-cache.js'

const root = 'D:\\test-branch'
let directory: string

/** 构造一份最小合法的缓存条目 */
function makeEntry(overrides: Partial<SnapshotCacheFile> = {}): SnapshotCacheFile {
  const channel = { fetchedAt: '2026-11-16T00:00:00.000Z', ok: true, stale: false }
  return {
    version: SNAPSHOT_CACHE_VERSION,
    snapshotAt: '2026-11-16T00:00:00.000Z',
    workspacesRoot: root,
    segments: {
      local: {
        fetchedAt: '2026-11-16T00:00:00.000Z',
        channel,
        requirements: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        workspaces: [],
        localRootAvailable: true,
      },
      tapd: {
        fetchedAt: '2026-11-16T00:00:00.000Z',
        channel,
        enrichment: {},
      },
    },
    ...overrides,
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'devtask-snapshot-cache-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('SnapshotCache', () => {
  it('returns undefined when the cache file does not exist', () => {
    const cache = new SnapshotCache(directory)
    expect(cache.read(root)).toBeUndefined()
  })

  it('round-trips a valid entry and matches by workspacesRoot', async () => {
    const cache = new SnapshotCache(directory)
    await cache.write(makeEntry())

    expect(cache.read(root)).toEqual(makeEntry())
    // 根目录不匹配视为 miss，防止缓存串味
    expect(cache.read('D:\\somewhere-else')).toBeUndefined()
  })

  it('discards corrupt JSON', async () => {
    await writeFile(join(directory, 'snapshot-cache.json'), '{ not json', 'utf8')
    const cache = new SnapshotCache(directory)
    expect(cache.read(root)).toBeUndefined()
  })

  it('discards entries with a mismatched version', async () => {
    const cache = new SnapshotCache(directory)
    await cache.write(makeEntry({ version: 999 as SnapshotCacheFile['version'] }))
    expect(cache.read(root)).toBeUndefined()
  })

  it('discards entries that fail schema validation', async () => {
    const cache = new SnapshotCache(directory)
    const broken = makeEntry()
    // 直接写一份 requirements 形状非法的原始 JSON，规避类型系统的合法约束
    const invalid = {
      ...broken,
      segments: { ...broken.segments, local: { ...broken.segments.local, requirements: [{ bad: true }] } },
    }
    await writeFile(join(directory, 'snapshot-cache.json'), JSON.stringify(invalid), 'utf8')
    expect(cache.read(root)).toBeUndefined()
  })

  it('writes atomically: no temp files remain after a successful write', async () => {
    const cache = new SnapshotCache(directory)
    await cache.write(makeEntry())
    const files = await readdir(directory)
    expect(files).toEqual(['snapshot-cache.json'])
  })
})
