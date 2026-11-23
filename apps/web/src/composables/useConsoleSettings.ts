import { ref } from 'vue'
import { consoleSettingsSchema, type ConsoleSettings } from '@devtask/shared'
import { apiRequest } from '../api/client'

/**
 * 控制台可编辑配置的加载与保存。
 * 配置存后端本地 JSON，经 GET/PUT /api/v1/settings 读写；本 hook 只负责网络与状态，
 * 保存后的业务联动（刷新候选 / 看板等）由 useConsole 的 saveSettings 负责。
 * @returns 配置状态与加载/保存动作
 */
export function useConsoleSettings() {
  const settings = ref<ConsoleSettings>({})
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  // 请求序号：并发的 load/update 只有最后发起者能写 settings，
  // 避免后台 load 的旧响应覆盖用户刚保存的新值
  let requestSequence = 0

  /**
   * 从后端加载配置。
   * @returns Promise<void>，错误写入 error
   */
  async function load(): Promise<void> {
    const sequence = ++requestSequence
    loading.value = true
    error.value = ''
    try {
      const result: unknown = await apiRequest('/api/v1/settings')
      const parsed = consoleSettingsSchema.parse(result)
      if (sequence === requestSequence) settings.value = parsed
    } catch (cause) {
      if (sequence === requestSequence) {
        error.value = cause instanceof Error ? cause.message : '配置加载失败。'
      }
    } finally {
      if (sequence === requestSequence) loading.value = false
    }
  }

  /**
   * 保存配置（合并更新，只提交传入字段）。
   * @param patch 要更新的配置字段
   * @returns 是否保存成功
   */
  async function update(patch: ConsoleSettings): Promise<boolean> {
    const sequence = ++requestSequence
    saving.value = true
    error.value = ''
    try {
      const result: unknown = await apiRequest('/api/v1/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
      const parsed = consoleSettingsSchema.parse(result)
      if (sequence === requestSequence) settings.value = parsed
      return true
    } catch (cause) {
      if (sequence === requestSequence) {
        error.value = cause instanceof Error ? cause.message : '配置保存失败。'
      }
      return false
    } finally {
      if (sequence === requestSequence) saving.value = false
    }
  }

  return { settings, loading, saving, error, load, update }
}
