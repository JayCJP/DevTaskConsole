import { defineStore } from 'pinia'
import { ref } from 'vue'
import { snapshotSchema, type Snapshot } from '@devtask/shared'
import { apiRequest } from '../api/client'

export const useConsoleStore = defineStore('console', () => {
  const snapshot = ref<Snapshot | null>(null)
  const loading = ref(false)
  const error = ref('')
  const refreshedAt = ref('')
  /** 首次加载标记：用于区分“尚未加载”与“加载完成但确实没有数据” */
  const loaded = ref(false)
  /** 在途请求：按“是否强制刷新”分开去重，手动刷新不会被在途的增量刷新吞掉 */
  const inflight = new Map<boolean, Promise<void>>()
  /** 已落地快照的时间戳：多请求并发时丢弃迟到的旧响应，避免覆盖刚同步的新数据 */
  let appliedSnapshotAt = ''

  /**
   * 拉取控制台统一快照。
   * 同一个请求在途时复用同一个 Promise，避免页面挂载与操作回调重复触发。
   * @param force 为 true 时跳过服务端 TAPD 增强字段缓存（用户手动刷新时使用）
   * @returns Promise<void>，失败信息写入 error 并保留上一次成功的快照
   */
  async function refresh(force = false): Promise<void> {
    const existing = inflight.get(force)
    if (existing) return existing
    const task = (async () => {
      loading.value = true
      error.value = ''
      try {
        const payload: unknown = await apiRequest(force ? '/api/v1/snapshot?refresh=1' : '/api/v1/snapshot')
        const parsed = snapshotSchema.parse(payload)
        // force 与普通请求可并发（inflight 按 force 分 key）：只接受不早于已落地快照的响应
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
        inflight.delete(force)
      }
    })()
    inflight.set(force, task)
    return task
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

  return { snapshot, loading, error, refreshedAt, loaded, refresh, ensureLoaded }
})
