import { ref } from 'vue'
import { cronDispatchSchema, type CronDispatch } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 派发轮次的归档终态 */
export type DispatchOutcome = 'succeeded' | 'failed' | 'stopped'

/**
 * 站点登记的派发轮次读取与归档。
 * 同一任务存在未归档轮次时服务端会拒绝再次派发，
 * 因此页面必须提供归档入口，否则任务会一直卡在「有未归档轮次」状态。
 * @param onChanged 归档成功后的回调（例如刷新任务列表）
 * @returns 轮次列表、加载状态与归档方法
 */
export function useCronDispatches(onChanged?: () => Promise<void> | void) {
  /** 全部轮次登记（含已归档） */
  const dispatches = ref<CronDispatch[]>([])
  /** 是否正在加载 */
  const loading = ref(false)
  /** 错误信息 */
  const error = ref('')
  /** 正在归档的轮次 ID */
  const archivingId = ref<string | null>(null)

  /**
   * 拉取全部轮次登记。
   * @returns Promise<void>
   */
  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const result = await apiRequest<{ dispatches: unknown[] }>('/api/v1/crons/dispatches')
      dispatches.value = cronDispatchSchema.array().parse(result.dispatches)
    } catch (cause) {
      // 轮次信息属于增强提示：读取失败不阻塞任务列表，仅在归档入口附近提示
      error.value = cause instanceof Error ? cause.message : '派发轮次加载失败。'
    } finally {
      loading.value = false
    }
  }

  /**
   * 查询某任务当前未归档的轮次。
   * @param taskId 任务 ID
   * @returns 未归档轮次；不存在时返回 undefined
   */
  function openRoundOf(taskId: string): CronDispatch | undefined {
    return dispatches.value.find((dispatch) => dispatch.taskId === taskId && dispatch.state === 'open')
  }

  /**
   * 归档一个轮次，归档后该任务才允许再次派发。
   * @param taskId 任务 ID
   * @param roundId 轮次 ID
   * @param outcome 终态
   * @returns 是否归档成功
   */
  async function archive(taskId: string, roundId: string, outcome: DispatchOutcome): Promise<boolean> {
    archivingId.value = roundId
    error.value = ''
    try {
      await apiRequest(
        `/api/v1/crons/${encodeURIComponent(taskId)}/dispatches/${encodeURIComponent(roundId)}/archive`,
        { method: 'POST', body: JSON.stringify({ outcome }) },
      )
      await refresh()
      await onChanged?.()
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '归档轮次失败。'
      return false
    } finally {
      archivingId.value = null
    }
  }

  return { dispatches, loading, error, archivingId, refresh, openRoundOf, archive }
}
