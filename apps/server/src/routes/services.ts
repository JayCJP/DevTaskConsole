import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServiceEvent } from '@devtask/shared'
import type { CronMappingStore } from '../aggregator/cron-data.js'
import type { AuditLog } from '../services/audit-log.js'
import type { CronDispatchStore } from '../services/cron-dispatch.js'
import type { ScheduledTaskClient } from '../services/scheduled-tasks.js'
import type { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { RouteError, controlError, invalidParameters } from './support.js'

/** Story 服务生命周期路由依赖 */
export interface ServiceRouteDeps {
  /** 服务登记表 */
  supervisor: StoryServiceSupervisor
  /** 运行期监督事件来源；未启用监督时缺省 */
  monitor?: { list(limit?: number): ServiceEvent[] }
  /** 定时任务 owner/模式映射 */
  mappings: CronMappingStore
  /** CodeBuddy 定时任务客户端，用于停服前暂停任务 */
  client: ScheduledTaskClient
  /** 站点派发轮次登记 */
  dispatches: CronDispatchStore
  /** 审计流水 */
  audit: AuditLog
}

const storyIdSchema = z.string().min(1).max(200)

/**
 * 注册 Story 服务生命周期与监督事件路由。
 * @param app Fastify 实例
 * @param deps 路由依赖
 * @returns 无返回值
 */
export function registerServiceRoutes(app: FastifyInstance, deps: ServiceRouteDeps): void {
  app.get('/api/v1/services/events', async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    try {
      return { events: deps.monitor?.list(query.data.limit) ?? [] }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/service/stop', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await deps.supervisor.inspect(params.data.storyId)
      if (!service) {
        throw new RouteError(404, 'STORY_SERVICE_NOT_FOUND', 'No CodeBuddy service has been assigned to this Story.')
      }
      const pause = await pauseOwnedTasks(deps, params.data.storyId, service.port, service.status === 'running')
      const stopped = await deps.supervisor.stop(params.data.storyId)
      await deps.audit.record({
        action: 'service.stop',
        target: params.data.storyId,
        storyId: params.data.storyId,
        before: { status: service.status, port: service.port },
        after: { status: stopped.status, pausedTasks: pause.paused },
        reversible: false,
      })
      return { storyId: stopped.storyId, status: stopped.status, pausedTasks: pause.paused, warnings: pause.warnings }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.delete('/api/v1/stories/:storyId/service', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const openRounds = (await deps.dispatches.list()).filter(
        (dispatch) => dispatch.storyId === params.data.storyId && dispatch.state === 'open',
      )
      if (openRounds.length > 0) {
        throw new RouteError(
          409,
          'CRON_DISPATCH_OPEN',
          `该 Story 还有 ${openRounds.length} 个未归档派发轮次，请先归档再删除服务映射。`,
        )
      }
      const removed = await deps.supervisor.remove(params.data.storyId)
      const mappings = (await deps.mappings.list()).filter((mapping) => mapping.storyId === params.data.storyId)
      await deps.audit.record({
        action: 'service.remove',
        target: params.data.storyId,
        storyId: params.data.storyId,
        before: { port: removed.port, status: removed.status },
        reversible: false,
      })
      return {
        storyId: removed.storyId,
        removed: true,
        // 任务本身属于 CodeBuddy，不在删映射时连带删除；如实提示仍绑定的任务数量
        boundTasks: mappings.map((mapping) => mapping.taskId),
      }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })
}

/**
 * 停服前暂停该 Story 名下所有可识别的定时任务。
 * 服务不可用时无法调用上游，只能保留映射并给出告警，不谎报「已暂停」。
 * @param deps 路由依赖
 * @param storyId Story 标识
 * @param port 服务端口
 * @param reachable 上游是否可达
 * @returns 已暂停的任务 ID 与告警
 */
async function pauseOwnedTasks(
  deps: ServiceRouteDeps,
  storyId: string,
  port: number,
  reachable: boolean,
): Promise<{ paused: string[]; warnings: string[] }> {
  const mappings = (await deps.mappings.list()).filter((mapping) => mapping.storyId === storyId)
  if (mappings.length === 0) return { paused: [], warnings: [] }
  if (!reachable) {
    return {
      paused: [],
      warnings: ['服务不在运行态，无法暂停其定时任务；这些任务可能仍会按原计划触发。'],
    }
  }

  const paused: string[] = []
  const warnings: string[] = []
  let tasks: Array<{ id: string; enabled?: boolean }> = []
  try {
    tasks = await deps.client.list(port)
  } catch (error) {
    return {
      paused: [],
      warnings: [`读取定时任务列表失败，未暂停任何任务：${messageOf(error)}`],
    }
  }

  for (const mapping of mappings) {
    const task = tasks.find((item) => item.id === mapping.taskId)
    if (!task) continue
    if (task.enabled === false) {
      // 已经是暂停状态，只补记「由停服暂停」来源，便于恢复时区分手动暂停
      await deps.mappings.update(mapping.taskId, { pausedByServiceStop: true })
      continue
    }
    try {
      await deps.client.update(port, mapping.taskId, { enabled: false })
      await deps.mappings.update(mapping.taskId, { pausedByServiceStop: true })
      paused.push(mapping.taskId)
    } catch (error) {
      warnings.push(`暂停任务 ${mapping.taskId} 失败：${messageOf(error)}`)
    }
  }
  return { paused, warnings }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
