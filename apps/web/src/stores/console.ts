import { defineStore } from 'pinia'
import { ref } from 'vue'
import { snapshotSchema, type Snapshot } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 可按段刷新的快照段（与后端 SnapshotSegment 对应） */
export type SnapshotSegment = 'local' | 'tapd'

export const useConsoleStore = defineStore('console', () => {
  const snapshot = ref<Snapshot | null>(null)
  const loading = ref(false)
  const error = ref('')
  const refreshedAt = ref('')
  /** 首次加载标记：用于区分“尚未加载”与“加载完成但确实没有数据” */
  const loaded = ref(false)
  /**
   * 在途请求：按“force + segments”组合分 key 去重。
   * 普通刷新、手动全量刷新、按段刷新三者互不吞掉。
   */
  const inflight = new Map<string, Promise<void>>()
  /** 已落地快照的时间戳：多请求并发时丢弃迟到的旧响应，避免覆盖刚同步的新数据 */
  let appliedSnapshotAt = ''

  /**
   * 拉取统一快照的内部实现。
   * @param force 是否全量强制重建（含 TAPD/连通性）
   * @param segments 按段定向失效的段列表；pipeline/inbox 只需 local
   * @param key inflight 去重键
   * @returns Promise<void>，失败信息写入 error 并保留上一次成功的快照
   */
  async function fetchSnapshot(force: boolean, segments: SnapshotSegment[] | undefined, key: string): Promise<void> {
    const existing = inflight.get(key)
    if (existing) return existing
    const task = (async () => {
      loading.value = true
      error.value = ''
      try {
        const params = new URLSearchParams()
        if (force) params.set('refresh', '1')
        if (segments?.length) params.set('segments', segments.join(','))
        const query = params.toString()
        const payload: unknown = await apiRequest(`/api/v1/snapshot${query ? `?${query}` : ''}`)
        const parsed = snapshotSchema.parse(payload)
        // 不同 force/segments 的请求可并发：只接受不早于已落地快照的响应
        if (parsed.snapshotAt < appliedSnapshotAt) return
        snapshot.value = parsed
        appliedSnapshotAt = parsed.snapshotAt
        refreshedAt.value = new Date().toISOString()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : 'Snapshot request failed.'
        if (snapshot.value) {
          error.value = `${error.value} Showing the last successful snapshot.`
        }
      } finally {
        loading.value = false
        loaded.value = true
        inflight.delete(key)
      }
    })()
    inflight.set(key, task)
    return task
  }

  /**
   * 全量刷新快照（兼容原行为）。
   * @param force 为 true 时重建全部缓存段并刷新连通性（用户手动刷新时使用）
   * @returns Promise<void>
   */
  async function refresh(force = false): Promise<void> {
    await fetchSnapshot(force, undefined, `force:${force}`)
  }

  /**
   * 按段刷新快照：仅重建指定段，其余段复用服务端缓存。
   * pipeline / inbox 的数据来自 local 段（工作区扫描/harness）与 runtime 段，
   * 传 ['local'] 即可刷新它们而完全不触达 TAPD/连通性，避免 429。
   * @param segments 需要重建的段，如 ['local']
   * @returns Promise<void>
   */
  async function refreshSegments(segments: SnapshotSegment[]): Promise<void> {
    await fetchSnapshot(false, segments, `segments:${segments.join(',')}`)
  }

  /**
   * 确保快照至少加载过一次。
   * 刷新页面或直接进入深链接时由页面调用，保证首屏有数据。
   * @returns Promise<void>
   */
  async function ensureLoaded(): Promise<void> {
    if (snapshot.value || loading.value) return
    await refresh()
  }

  return { snapshot, loading, error, refreshedAt, loaded, refresh, refreshSegments, ensureLoaded }
})
