import type { CronMappingStore } from '../aggregator/cron-data.js'
import type { ScheduledTaskClient } from './scheduled-tasks.js'
import type { StoryServiceSupervisor } from './story-service-supervisor.js'

/** 恢复流程依赖 */
export interface CronRecoveryDeps {
  /** owner/模式映射 */
  mappings: CronMappingStore
  /** 服务注册表 */
  supervisor: StoryServiceSupervisor
  /** 定时任务客户端 */
  client: ScheduledTaskClient
  /** 可注入的日志回调，默认静默 */
  log?: (message: string) => void
}

/** 恢复结果 */
export interface CronRecoveryResult {
  /** 已重新启用的任务 */
  restored: string[]
  /** 因服务不可用而跳过的任务 */
  skipped: string[]
  /** 因 owner 校验失败或上游失败而未恢复的任务 */
  failed: string[]
}

/**
 * 服务恢复后恢复 cron owner 并重新启用被停服暂停的任务。
 * 顺序严格为「先校验 owner 属于该工作区，再启用任务」：
 * owner 校验失败时保持暂停，避免任务绑定到错误的会话。
 * 只有由站点因停服暂停（pausedByServiceStop）的任务会被自动启用，
 * 用户手动暂停的任务不受影响。
 * @param deps 恢复依赖
 * @returns 恢复结果分类
 */
export async function restoreCronOwners(deps: CronRecoveryDeps): Promise<CronRecoveryResult> {
  const result: CronRecoveryResult = { restored: [], skipped: [], failed: [] }
  const mappings = (await deps.mappings.list()).filter((mapping) => mapping.pausedByServiceStop === true)

  for (const mapping of mappings) {
    const service = await deps.supervisor.inspect(mapping.storyId)
    if (!service || service.status !== 'running') {
      result.skipped.push(mapping.taskId)
      deps.log?.(`跳过 ${mapping.taskId}：Story ${mapping.storyId} 的服务未运行。`)
      continue
    }
    try {
      const sessionIds = await deps.client.listSessionIds(service.port, service.cwd)
      if (!sessionIds.includes(mapping.ownerSessionId)) {
        result.failed.push(mapping.taskId)
        deps.log?.(`未恢复 ${mapping.taskId}：owner 会话已不属于该工作区，任务保持暂停。`)
        continue
      }
      await deps.client.update(service.port, mapping.taskId, {
        enabled: true,
        ownerSessionId: mapping.ownerSessionId,
      })
      await deps.mappings.update(mapping.taskId, {
        pausedByServiceStop: false,
        ownerVerifiedAt: new Date().toISOString(),
      })
      result.restored.push(mapping.taskId)
    } catch (error) {
      result.failed.push(mapping.taskId)
      deps.log?.(`恢复 ${mapping.taskId} 失败：${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }
  return result
}
