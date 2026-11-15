import { onUnmounted, ref } from 'vue'

/** 操作结果提示 */
export interface ActionToast {
  /** 提示 ID */
  id: string
  /** 展示文案 */
  message: string
  /** 成功或失败，决定配色与图标语义 */
  kind: 'success' | 'error'
}

/** 提示自动消失时间（毫秒） */
const toastLifetimeMs = 8_000

/**
 * 通用的操作结果提示。
 * 用于「暂停/重启/删除」这类没有后续表单的写操作：
 * 成功与失败都给出明确反馈，避免用户只能看到按钮 loading 一闪。
 * @returns 提示列表、新增与关闭方法
 */
export function useActionToasts() {
  /** 当前提示，最新的在最后（右下角向上堆叠） */
  const toasts = ref<ActionToast[]>([])
  /** 各提示的自动消失定时器 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 提示序号 */
  let sequence = 0

  /**
   * 关闭一条提示并清理它的定时器。
   * @param id 提示 ID
   */
  function dismiss(id: string): void {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  /**
   * 新增一条提示，8 秒后自动消失。
   * @param message 展示文案
   * @param kind 成功或失败
   */
  function notify(message: string, kind: ActionToast['kind']): void {
    sequence += 1
    const id = `action-toast-${sequence}`
    toasts.value = [...toasts.value, { id, message, kind }]
    const timer = setTimeout(() => dismiss(id), toastLifetimeMs)
    timers.set(id, timer)
  }

  onUnmounted(() => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  return { toasts, notify, dismiss }
}
