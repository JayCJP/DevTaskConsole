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
  let inflight: Promise<void> | null = null

  /**
   * 拉取控制台统一快照。
   * 同一个请求在途时复用同一个 Promise，避免页面挂载与定时器重复触发。
   * @returns Promise<void>，失败信息写入 error 并保留上一次成功的快照
   */
  async function refresh(): Promise<void> {
    if (inflight) return inflight
    inflight = (async () => {
      loading.value = true
      error.value = ''
      try {
        const payload: unknown = await apiRequest('/api/v1/snapshot')
        snapshot.value = snapshotSchema.parse(payload)
        refreshedAt.value = new Date().toISOString()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : 'Snapshot request failed.'
        if (snapshot.value) {
          error.value = `${error.value} Showing the last successful snapshot.`
        }
      } finally {
        loading.value = false
        loaded.value = true
        inflight = null
      }
    })()
    return inflight
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
