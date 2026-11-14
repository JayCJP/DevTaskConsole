import { ref } from 'vue'
import { auditEntrySchema, type AuditEntry } from '@devtask/shared'
import { apiRequest } from '../api/client'

/**
 * 审计流水的读取与撤销。
 * 撤销只对服务端白名单内的动作开放；不可撤销动作在界面上直接置灰并说明原因。
 * @param onUndone 撤销成功后的回调，用于刷新快照
 * @returns 条目、加载状态与动作方法
 */
export function useAuditTrail(onUndone?: () => Promise<void>) {
  /** 审计条目，最新的在最前 */
  const entries = ref<AuditEntry[]>([])
  /** 是否加载中 */
  const loading = ref(false)
  /** 错误信息 */
  const error = ref('')
  /** 正在撤销的条目 ID */
  const undoingId = ref<string | null>(null)

  /**
   * 拉取最近审计条目。
   * @param limit 条数上限，默认 100
   * @returns Promise<void>
   */
  async function refresh(limit = 100): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const result = await apiRequest<{ entries: unknown[] }>(`/api/v1/audit?limit=${limit}`)
      entries.value = auditEntrySchema.array().parse(result.entries)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '审计流水加载失败。'
    } finally {
      loading.value = false
    }
  }

  /**
   * 撤销一条审计动作。
   * @param id 审计条目 ID
   * @returns 是否撤销成功
   */
  async function undo(id: string): Promise<boolean> {
    undoingId.value = id
    error.value = ''
    try {
      await apiRequest(`/api/v1/audit/${encodeURIComponent(id)}/undo`, { method: 'POST' })
      await refresh()
      await onUndone?.()
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '撤销失败。'
      return false
    } finally {
      undoingId.value = null
    }
  }

  /**
   * 判断条目当前是否可撤销。
   * @param entry 审计条目
   * @returns 可撤销返回 true
   */
  function canUndo(entry: AuditEntry): boolean {
    return entry.reversible && !entry.undone && entry.result === 'succeeded'
  }

  return { entries, loading, error, undoingId, refresh, undo, canUndo }
}
