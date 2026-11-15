import { ref } from 'vue'
import { jobDetailSchema, jobPrefsSchema, type JobDetail, type JobPrefs } from '@devtask/shared'
import { apiRequest } from '../api/client'

/**
 * 实例的增强信息：详情（当前活动/等待原因/建议回复）与列表偏好（置顶/分组）。
 * 详情随选中的实例变化，偏好按 Story 服务维度读取；
 * 两者都是 CodeBuddy 的事实数据，本站只缓存展示用副本，不另建存储。
 * @returns 详情、偏好及对应的加载与写操作方法
 */
export function useJobExtras() {
  /** 当前选中实例的详情 */
  const detail = ref<JobDetail | null>(null)
  /** 详情加载中 */
  const detailLoading = ref(false)
  /** 详情读取失败原因 */
  const detailError = ref('')
  /** 当前 Story 的列表偏好 */
  const prefs = ref<JobPrefs>({ pinned: [], groups: {} })
  /** 置顶写操作进行中 */
  const pinSaving = ref(false)
  /** 偏好读取/写入失败原因 */
  const prefsError = ref('')
  /** 详情请求序号，避免旧请求覆盖新选中的实例 */
  let detailSequence = 0

  /**
   * 读取实例详情。
   * @param storyId Story 标识（决定调用哪台服务）
   * @param jobId 实例 ID
   * @returns Promise<void>
   */
  async function loadDetail(storyId: string, jobId: string): Promise<void> {
    const sequence = ++detailSequence
    detailLoading.value = true
    detailError.value = ''
    try {
      const result = await apiRequest<unknown>(
        `/api/v1/stories/${encodeURIComponent(storyId)}/jobs/${encodeURIComponent(jobId)}`,
      )
      if (sequence !== detailSequence) return
      detail.value = jobDetailSchema.parse(result)
    } catch (cause) {
      if (sequence !== detailSequence) return
      detail.value = null
      detailError.value = cause instanceof Error ? cause.message : '读取实例详情失败。'
    } finally {
      if (sequence === detailSequence) detailLoading.value = false
    }
  }

  /**
   * 读取列表偏好。
   * @param storyId Story 标识
   * @returns Promise<void>
   */
  async function loadPrefs(storyId: string): Promise<void> {
    try {
      const result = await apiRequest<unknown>(`/api/v1/stories/${encodeURIComponent(storyId)}/jobs/prefs`)
      prefs.value = jobPrefsSchema.parse(result)
    } catch (cause) {
      // 偏好属于增强能力，失败时保持默认（不置顶），并记录原因供界面提示
      prefsError.value = cause instanceof Error ? cause.message : '读取列表偏好失败。'
    }
  }

  /**
   * 切换置顶状态，采用乐观更新，失败时回滚。
   * @param storyId Story 标识
   * @param jobId 实例 ID
   * @param pinned 目标置顶状态
   * @returns Promise<void>
   */
  async function togglePin(storyId: string, jobId: string, pinned: boolean): Promise<void> {
    const previous = prefs.value
    const nextPinned = pinned
      ? [...new Set([...previous.pinned, jobId])]
      : previous.pinned.filter((id) => id !== jobId)
    prefs.value = { ...previous, pinned: nextPinned }
    pinSaving.value = true
    prefsError.value = ''
    try {
      const result = await apiRequest<unknown>(`/api/v1/stories/${encodeURIComponent(storyId)}/jobs/prefs`, {
        method: 'PUT',
        body: JSON.stringify({ id: jobId, pinned }),
      })
      prefs.value = jobPrefsSchema.parse(result)
    } catch (cause) {
      prefs.value = previous
      prefsError.value = cause instanceof Error ? cause.message : '更新置顶失败。'
    } finally {
      pinSaving.value = false
    }
  }

  /** 清空详情（切换实例或离开页面时调用）。 */
  function clearDetail(): void {
    detailSequence += 1
    detail.value = null
    detailError.value = ''
    detailLoading.value = false
  }

  return {
    detail,
    detailLoading,
    detailError,
    prefs,
    pinSaving,
    prefsError,
    loadDetail,
    loadPrefs,
    togglePin,
    clearDetail,
  }
}
