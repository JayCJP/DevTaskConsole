import { onUnmounted, ref, type Ref } from 'vue'
import type { AuditAction, Cron, CronMode } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 撤销提示条 */
export interface CronUndoNotice {
  /** 提示唯一标识 */
  id: string
  /** 展示文案 */
  message: string
  /** 对应审计条目 ID；缺省表示该动作不可撤销 */
  auditId?: string
}

/** composer 依赖 */
export interface CronActionsOptions {
  /** 动作成功后刷新快照 */
  onRefresh: () => Promise<void>
  /** 统一错误出口，由页面展示 */
  onError: (message: string) => void
}

/** 撤销提示的存活时间（毫秒） */
const noticeTimeoutMs = 8_000

/** 单次写操作的描述 */
interface CronActionConfig {
  /** 失败时的兜底文案 */
  errorMessage: string
  /** 成功后的提示文案；缺省表示不提示 */
  successMessage?: string
  /** 对应的审计动作；提供时会尝试取回审计条目以便撤销 */
  auditAction?: AuditAction
  /** 乐观覆盖字段，失败时整体回滚 */
  optimistic?: Partial<Cron>
}

/**
 * 定时任务写操作的统一入口。
 * 采用「乐观更新 + 失败回滚」：先本地覆盖展示值，请求成功后刷新快照，
 * 失败则撤销本地覆盖并回报错误。可撤销动作成功后给出撤销提示条。
 * 所有写操作共用同一条执行路径，避免各动作各自实现一遍忙碌标记与错误处理。
 * @param options 刷新与错误回调
 * @returns 覆盖表、忙碌标记、提示条与动作方法
 */
export function useCronActions(options: CronActionsOptions) {
  /** 任务 ID → 本地覆盖字段；仅用于乐观展示 */
  const overrides = ref<Record<string, Partial<Cron>>>({})
  /** 正在执行动作的任务 ID；用于禁用该行按钮 */
  const busyTaskId = ref<string | null>(null)
  /** 撤销提示列表 */
  const notices = ref<CronUndoNotice[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  // 页面卸载后不再保留提示定时器，避免回调触达已销毁的组件状态
  onUnmounted(() => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  /**
   * 写入本地覆盖。
   * @param taskId 任务 ID
   * @param patch 覆盖字段
   */
  function apply(taskId: string, patch: Partial<Cron>): void {
    overrides.value = { ...overrides.value, [taskId]: { ...overrides.value[taskId], ...patch } }
  }

  /**
   * 撤销本地覆盖（回滚到快照值）。
   * @param taskId 任务 ID
   */
  function revert(taskId: string): void {
    const next = { ...overrides.value }
    delete next[taskId]
    overrides.value = next
  }

  /**
   * 弹出撤销提示条，超时自动消失。
   * @param message 展示文案
   * @param auditId 审计条目 ID
   */
  function notify(message: string, auditId?: string): void {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    notices.value = [...notices.value, { id, message, ...(auditId ? { auditId } : {}) }]
    timers.set(id, setTimeout(() => dismiss(id), noticeTimeoutMs))
  }

  /**
   * 关闭一条提示。
   * @param id 提示 ID
   */
  function dismiss(id: string): void {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    notices.value = notices.value.filter((notice) => notice.id !== id)
  }

  /**
   * 查询刚刚产生的审计条目 ID，用于提供撤销入口。
   * @param target 动作目标
   * @param action 预期动作
   * @returns 审计条目 ID；未找到时返回 undefined
   */
  async function latestAuditId(target: string, action: AuditAction): Promise<string | undefined> {
    try {
      const result = await apiRequest<{ entries: Array<{ id: string; action: string; target: string; undone: boolean }> }>(
        '/api/v1/audit?limit=10',
      )
      const entry = result.entries.find((item) => item.target === target && item.action === action && !item.undone)
      return entry?.id
    } catch {
      // 撤销入口属于增强能力，取不到不影响主流程
      return undefined
    }
  }

  /**
   * 执行一次写操作并统一处理忙碌标记、刷新、提示与回滚。
   * @param taskId 目标任务
   * @param operation 实际请求
   * @param config 提示文案与乐观覆盖
   * @returns 是否成功
   */
  async function run(
    taskId: string,
    operation: () => Promise<void>,
    config: CronActionConfig,
  ): Promise<boolean> {
    busyTaskId.value = taskId
    if (config.optimistic) apply(taskId, config.optimistic)
    try {
      await operation()
      await options.onRefresh()
      if (config.successMessage) {
        const auditId = config.auditAction ? await latestAuditId(taskId, config.auditAction) : undefined
        notify(config.successMessage, auditId)
      }
      return true
    } catch (error) {
      revert(taskId)
      options.onError(error instanceof Error ? error.message : config.errorMessage)
      return false
    } finally {
      busyTaskId.value = null
    }
  }

  /**
   * 启用或暂停任务。
   * @param cron 任务
   * @param enabled 目标状态
   */
  async function toggle(cron: Cron, enabled: boolean): Promise<void> {
    await run(
      cron.id,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(cron.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        })
      },
      {
        optimistic: { enabled },
        successMessage: `已${enabled ? '启用' : '暂停'}任务 ${cron.id}`,
        auditAction: 'cron.toggle',
        errorMessage: '启停任务失败。',
      },
    )
  }

  /**
   * 修改任务的 cron 表达式与 prompt。
   * @param cron 任务
   * @param input 新的表达式与提示词
   */
  async function update(cron: Cron, input: { cron: string; prompt?: string }): Promise<boolean> {
    return run(
      cron.id,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(cron.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
      },
      {
        optimistic: { cron: input.cron },
        successMessage: `已更新任务 ${cron.id} 的调度规则`,
        auditAction: 'cron.update',
        errorMessage: '更新调度规则失败。',
      },
    )
  }

  /**
   * 删除任务（不可撤销，调用方需二次确认）。
   * @param cron 任务
   */
  async function remove(cron: Cron): Promise<void> {
    await run(
      cron.id,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(cron.id)}`, { method: 'DELETE' })
      },
      {
        successMessage: `已删除任务 ${cron.id}（不可撤销）`,
        errorMessage: '删除任务失败。',
      },
    )
  }

  /**
   * 续期持久化任务。
   * @param cron 任务
   */
  async function renew(cron: Cron): Promise<void> {
    await run(
      cron.id,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(cron.id)}/renew`, { method: 'POST' })
      },
      { successMessage: `已续期任务 ${cron.id}`, errorMessage: '续期任务失败。' },
    )
  }

  /**
   * 派发到独立的 StoryRound Job。
   * @param cron 任务
   * @param prompt 可选的自定义提示词
   * @returns 是否派发成功
   */
  async function dispatch(cron: Cron, prompt?: string): Promise<boolean> {
    return run(
      cron.id,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(cron.id)}/dispatch`, {
          method: 'POST',
          body: JSON.stringify(prompt ? { prompt } : {}),
        })
      },
      { successMessage: `已派发任务 ${cron.id} 到独立轮次`, errorMessage: '派发轮次失败。' },
    )
  }

  /**
   * 保存 owner 映射（默认会校验 session 归属）。
   * @param taskId 任务 ID
   * @param draft 映射草稿
   * @returns 是否保存成功
   */
  async function saveOwner(
    taskId: string,
    draft: { storyId: string; ownerSessionId: string; mode: CronMode | '' },
  ): Promise<boolean> {
    if (!draft.storyId || !draft.ownerSessionId.trim() || !draft.mode) return false
    return run(
      taskId,
      async () => {
        await apiRequest(`/api/v1/crons/${encodeURIComponent(taskId)}/mapping`, {
          method: 'PUT',
          body: JSON.stringify({
            storyId: draft.storyId,
            ownerSessionId: draft.ownerSessionId.trim(),
            mode: draft.mode,
          }),
        })
      },
      { errorMessage: '保存 owner 映射失败。' },
    )
  }

  /**
   * 撤销一条审计动作。
   * @param auditId 审计条目 ID
   */
  async function undo(auditId: string): Promise<void> {
    try {
      await apiRequest(`/api/v1/audit/${encodeURIComponent(auditId)}/undo`, { method: 'POST' })
      await options.onRefresh()
      notices.value = notices.value.filter((notice) => notice.auditId !== auditId)
    } catch (error) {
      options.onError(error instanceof Error ? error.message : '撤销失败。')
    }
  }

  return {
    /** 本地乐观覆盖表 */
    overrides: overrides as Ref<Record<string, Partial<Cron>>>,
    /** 正在处理的任务 ID */
    busyTaskId,
    /** 撤销提示条 */
    notices,
    toggle,
    update,
    remove,
    renew,
    dispatch,
    saveOwner,
    undo,
    dismiss,
  }
}
