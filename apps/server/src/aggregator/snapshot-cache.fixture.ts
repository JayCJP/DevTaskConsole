import { SNAPSHOT_CACHE_VERSION, type SnapshotCacheFile } from './snapshot-cache.js'

/** 测试夹具统一使用的时间戳与工作区根目录 */
export const FIXTURE_AT = '2026-11-16T00:00:00.000Z'
export const FIXTURE_ROOT = 'D:\\test-branch'

/**
 * 构造最小合法的快照缓存条目，供缓存读写与 provider 测试共用。
 * @param options.at 缓存与各段的时间戳
 * @param options.workspacesRoot 工作区根目录
 * @param options.overrides 顶层字段覆盖（如测试版本不匹配时传 version）
 * @returns 合法的缓存条目
 */
export function makeCacheEntry(options: {
  at?: string
  workspacesRoot?: string
  overrides?: Partial<SnapshotCacheFile>
} = {}): SnapshotCacheFile {
  const at = options.at ?? FIXTURE_AT
  const channel = { fetchedAt: at, ok: true, stale: false }
  return {
    version: SNAPSHOT_CACHE_VERSION,
    snapshotAt: at,
    workspacesRoot: options.workspacesRoot ?? FIXTURE_ROOT,
    segments: {
      local: {
        fetchedAt: at,
        channel,
        requirements: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        workspaces: [],
        localRootAvailable: true,
      },
      tapd: { fetchedAt: at, channel, enrichment: {} },
    },
    ...options.overrides,
  }
}
