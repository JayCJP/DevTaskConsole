import { computed, onUnmounted, ref } from 'vue'
import { serviceEventSchema, type ServiceEvent } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** Story 服务对外展示字段 */
export interface StoryServiceInfo {
  storyId: string
  /** 分配的端口；未分配时缺省 */
  port?: number
  status: string
  updatedAt: string
  error?: string
}

/** 监督事件轮询间隔（毫秒） */
const eventPollIntervalMs = 15_000

/**
 * Story 服务生命周期与运行期监督事件。
 * 负责启动、停止、删除映射与监督事件轮询；所有写操作失败都会保留原状态并回报错误，
 * 不做「假装已停止」的本地状态覆盖。
 * @param options 变更成功后的回调（例如刷新快照或任务列表）
 * @returns 服务状态、忙碌标记、事件与动作方法
 */
export function useServiceLifecycle(options: { onChange?: () => Promise<void> | void } = {}) {
  /** Story ID → 服务状态 */
  const services = ref<Record<string, StoryServiceInfo>>({})
  /** 正在操作中的 Story ID */
  const loadingStoryId = ref<string | null>(null)
  /** 错误信息（最近一次操作失败的原因，用于顶部提示） */
  const error = ref('')
  /** 按 Story 记录的错误，便于就近显示在对应卡片上 */
  const errors = ref<Record<string, string>>({})
  /** 监督事件 */
  const events = ref<ServiceEvent[]>([])
  /** 已关闭的事件 ID */
  const dismissed = ref<string[]>([])
  let timer: ReturnType<typeof setInterval> | undefined

  /** 用户尚未关闭的事件，最新的在最前 */
  const activeEvents = computed(() => events.value.filter((event) => !dismissed.value.includes(event.id)))

  /** 存在 error 级事件时用于顶部提醒条着色 */
  const hasServiceFailure = computed(() => activeEvents.value.some((event) => event.level === 'error'))

  /**
   * 拉取全部服务状态。
   * @returns Promise<void>
   */
  async function refresh(): Promise<void> {
    try {
      const list = await apiRequest<StoryServiceInfo[]>('/api/v1/stories/services')
      services.value = Object.fromEntries(list.map((service) => [service.storyId, service]))
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '读取服务状态失败。'
    }
  }

  /**
   * 启动或接管服务。
   * @param storyId Story 标识
   * @returns Promise<void>
   */
  async function start(storyId: string): Promise<void> {
    await mutate(storyId, async () => {
      const service = await apiRequest<StoryServiceInfo>(`/api/v1/stories/${encodeURIComponent(storyId)}/service`, {
        method: 'POST',
      })
      services.value = { ...services.value, [storyId]: service }
    })
  }

  /**
   * 停止服务：服务端会先暂停关联定时任务，再结束进程树并确认端口释放。
   * @param storyId Story 标识
   * @returns Promise<void>
   */
  async function stop(storyId: string): Promise<void> {
    await mutate(storyId, async () => {
      const result = await apiRequest<{ status: string; pausedTasks: string[]; warnings: string[] }>(
        `/api/v1/stories/${encodeURIComponent(storyId)}/service/stop`,
        { method: 'POST' },
      )
      if (result.warnings.length > 0) error.value = result.warnings.join('；')
    })
  }

  /**
   * 删除服务映射；仅当服务已停止且端口已释放时允许。
   * @param storyId Story 标识
   * @returns Promise<void>
   */
  async function remove(storyId: string): Promise<void> {
    await mutate(storyId, async () => {
      await apiRequest(`/api/v1/stories/${encodeURIComponent(storyId)}/service`, { method: 'DELETE' })
      const next = { ...services.value }
      delete next[storyId]
      services.value = next
    })
  }

  /**
   * 拉取监督事件。
   * @returns Promise<void>
   */
  async function refreshEvents(): Promise<void> {
    try {
      const result = await apiRequest<{ events: unknown[] }>('/api/v1/services/events?limit=50')
      events.value = serviceEventSchema.array().parse(result.events)
    } catch {
      // 监督事件属于增强提示，读取失败不覆盖主状态
    }
  }

  /**
   * 关闭一条事件提醒。
   * @param id 事件 ID
   */
  function dismissEvent(id: string): void {
    dismissed.value = [...dismissed.value, id]
  }

  /**
   * 启动事件轮询；组件卸载时自动停止。
   * @returns 无返回值
   */
  function startEventPolling(): void {
    if (timer) return
    void refreshEvents()
    timer = setInterval(() => { void refreshEvents() }, eventPollIntervalMs)
  }

  /** 停止事件轮询。 */
  function stopEventPolling(): void {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  onUnmounted(stopEventPolling)

  /**
   * 统一包装写操作：忙碌标记、错误回收与变更回调。
   * @param storyId Story 标识
   * @param operation 实际请求
   * @returns Promise<void>
   */
  async function mutate(storyId: string, operation: () => Promise<void>): Promise<void> {
    loadingStoryId.value = storyId
    error.value = ''
    errors.value = { ...errors.value, [storyId]: '' }
    try {
      await operation()
      await refresh()
      await options.onChange?.()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '服务操作失败。'
      error.value = message
      // 就近显示：失败原因绑定到该 Story 的卡片，避免用户只看到 loading 一闪
      errors.value = { ...errors.value, [storyId]: message }
    } finally {
      loadingStoryId.value = null
    }
  }

  /**
   * 读取某个 Story 最近的失败原因。
   * @param storyId Story 标识
   * @returns 错误文案；无错误时返回空字符串
   */
  function errorOf(storyId: string): string {
    return errors.value[storyId] ?? ''
  }

  return {
    services,
    loadingStoryId,
    error,
    errors,
    errorOf,
    events,
    activeEvents,
    hasServiceFailure,
    refresh,
    start,
    stop,
    remove,
    refreshEvents,
    dismissEvent,
    startEventPolling,
    stopEventPolling,
  }
}
