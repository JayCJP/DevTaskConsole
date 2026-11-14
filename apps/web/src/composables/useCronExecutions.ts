import { ref } from 'vue'
import { cronExecutionPageSchema, type CronExecution } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 执行记录过滤条件 */
export interface ExecutionFilters {
  /** 状态过滤 */
  status?: 'queued' | 'running' | 'succeeded' | 'failed'
  /** 关键词 */
  query?: string
}

/**
 * 定时任务执行记录的加载与分页。
 * 数据来源由服务端决定（API 优先、本地文件兜底），这里只负责展示与提示来源，
 * 不假设数据一定是实时的。
 * @returns 记录、加载状态、来源标记与加载方法
 */
export function useCronExecutions() {
  /** 当前任务的执行记录 */
  const executions = ref<CronExecution[]>([])
  /** 是否正在加载 */
  const loading = ref(false)
  /** 错误信息 */
  const error = ref('')
  /** 数据来源标记 */
  const source = ref<'api' | 'file'>('api')
  /** 兜底原因说明 */
  const warning = ref('')
  /** 是否还有下一页 */
  const hasMore = ref(false)
  /** 下一页游标 */
  const cursor = ref('')
  /** 当前展开的任务 ID；用于避免并发切换导致串数据 */
  const taskId = ref('')
  /** 当前过滤条件 */
  const filters = ref<ExecutionFilters>({})

  /**
   * 按任务与过滤条件重新加载第一页。
   * @param targetTaskId 任务 ID
   * @param nextFilters 过滤条件
   * @returns Promise<void>
   */
  async function load(targetTaskId: string, nextFilters: ExecutionFilters = {}): Promise<void> {
    taskId.value = targetTaskId
    filters.value = nextFilters
    cursor.value = ''
    loading.value = true
    error.value = ''
    try {
      const page = cronExecutionPageSchema.parse(await apiRequest<unknown>(buildUrl(targetTaskId, nextFilters)))
      if (taskId.value !== targetTaskId) return
      executions.value = page.executions
      hasMore.value = page.hasMore
      source.value = page.source
      cursor.value = page.nextCursor ?? ''
      warning.value = page.warning ?? ''
    } catch (cause) {
      if (taskId.value !== targetTaskId) return
      executions.value = []
      hasMore.value = false
      error.value = cause instanceof Error ? cause.message : '执行记录加载失败。'
    } finally {
      if (taskId.value === targetTaskId) loading.value = false
    }
  }

  /**
   * 追加加载下一页。
   * @returns Promise<void>
   */
  async function loadMore(): Promise<void> {
    if (!cursor.value || !taskId.value || loading.value) return
    const targetTaskId = taskId.value
    loading.value = true
    error.value = ''
    try {
      const page = cronExecutionPageSchema.parse(
        await apiRequest<unknown>(buildUrl(targetTaskId, filters.value, cursor.value)),
      )
      if (taskId.value !== targetTaskId) return
      executions.value = [...executions.value, ...page.executions]
      hasMore.value = page.hasMore
      cursor.value = page.nextCursor ?? ''
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '加载更多执行记录失败。'
    } finally {
      loading.value = false
    }
  }

  /**
   * 清空当前记录（收起行内列表时调用）。
   */
  function reset(): void {
    taskId.value = ''
    executions.value = []
    hasMore.value = false
    cursor.value = ''
    error.value = ''
    warning.value = ''
    source.value = 'api'
  }

  return { executions, loading, error, source, warning, hasMore, taskId, filters, load, loadMore, reset }
}

/**
 * 拼接执行记录查询地址。
 * @param taskId 任务 ID
 * @param filters 过滤条件
 * @param cursor 分页游标
 * @returns 请求路径
 */
function buildUrl(taskId: string, filters: ExecutionFilters, cursor = ''): string {
  const search = new URLSearchParams({ limit: '20' })
  if (filters.status) search.set('status', filters.status)
  if (filters.query) search.set('query', filters.query)
  if (cursor) search.set('cursor', cursor)
  return `/api/v1/crons/${encodeURIComponent(taskId)}/executions?${search}`
}
