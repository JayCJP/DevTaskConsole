import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Snapshot } from '@devtask/shared'
import type { CronMappingStore } from '../aggregator/cron-data.js'
import { isReversibleAction, type AuditLog } from '../services/audit-log.js'
import type { ScheduledTaskClient } from '../services/scheduled-tasks.js'
import type { StoryServiceSupervisor } from '../services/story-service-supervisor.js'
import { RouteError, controlError, invalidParameters } from './support.js'

/** 审计路由依赖 */
export interface AuditRouteDeps {
  /** 审计流水 */
  audit: AuditLog
  /** 快照读取，用于把审计目标定位到 Story 与端口 */
  snapshotProvider: () => Promise<Snapshot>
  /** 服务注册表 */
  supervisor: StoryServiceSupervisor
  /** CodeBuddy 定时任务客户端 */
  client: ScheduledTaskClient
  /** 本地映射，用于撤销 owner 变更 */
  mappings: CronMappingStore
}

const auditIdSchema = z.string().min(1).max(200)

/**
 * 注册审计流水与撤销路由。
 * @param app Fastify 实例
 * @param deps 路由依赖
 * @returns 无返回值
 */
export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get('/api/v1/audit', async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    try {
      return { entries: await deps.audit.list(query.data.limit) }
    } catch (error) {
      return controlError(request, reply, error)
    }
  })

  app.post('/api/v1/audit/:id/undo', async (request, reply) => {
    const params = z.object({ id: auditIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const entry = await deps.audit.find(params.data.id)
      if (!entry) throw new RouteError(404, 'AUDIT_ENTRY_NOT_FOUND', '审计记录不存在。')
      if (!entry.reversible || !isReversibleAction(entry.action)) {
        throw new RouteError(409, 'AUDIT_NOT_REVERSIBLE', '该动作不可撤销（例如删除任务或停止服务）。')
      }
      if (entry.undone) throw new RouteError(409, 'AUDIT_ALREADY_UNDONE', '该动作已经撤销过。')
      if (entry.result !== 'succeeded') {
        throw new RouteError(409, 'AUDIT_UNDO_UNAVAILABLE', '该动作当时未成功执行，无需撤销。')
      }

      const before = entry.before ?? {}
      if (entry.action === 'cron.owner') {
        const ownerSessionId = typeof before.ownerSessionId === 'string' ? before.ownerSessionId : undefined
        const mode = before.mode === 'query_only' || before.mode === 'query_fix' ? before.mode : undefined
        if (!ownerSessionId || !mode) {
          throw new RouteError(409, 'AUDIT_UNDO_UNSUPPORTED', '该条 owner 变更缺少可回滚的原始值。')
        }
        await deps.mappings.update(entry.target, { ownerSessionId, mode })
        await deps.audit.markUndone(entry.id)
        return { undone: true, applied: { ownerSessionId, mode } }
      }

      const context = await locateTarget(deps, entry.target)
      if (entry.action === 'cron.update') {
        const cron = typeof before.cron === 'string' ? before.cron : undefined
        if (!cron) throw new RouteError(409, 'AUDIT_UNDO_UNSUPPORTED', '该条更新缺少可回滚的原始 cron。')
        await deps.client.update(context.port, entry.target, { cron })
        await deps.audit.markUndone(entry.id)
        return { undone: true, applied: { cron } }
      }
      if (entry.action === 'cron.toggle') {
        if (typeof before.enabled !== 'boolean') {
          throw new RouteError(409, 'AUDIT_UNDO_UNSUPPORTED', '该条启停缺少可回滚的原始状态。')
        }
        await deps.client.update(context.port, entry.target, { enabled: before.enabled })
        await deps.audit.markUndone(entry.id)
        return { undone: true, applied: { enabled: before.enabled } }
      }
      throw new RouteError(409, 'AUDIT_UNDO_UNSUPPORTED', '该动作类型暂不支持撤销。')
    } catch (error) {
      return controlError(request, reply, error)
    }
  })
}

/**
 * 把审计目标定位到可用的 CodeBuddy 端口。
 * @param deps 路由依赖
 * @param taskId 定时任务 ID
 * @returns 端口与 Story
 */
async function locateTarget(deps: AuditRouteDeps, taskId: string): Promise<{ port: number; storyId: string }> {
  const snapshot = await deps.snapshotProvider()
  const cron = snapshot.crons.find((item) => item.id === taskId)
  if (!cron?.storyId) {
    throw new RouteError(409, 'CRON_STORY_UNMAPPED', '无法定位该任务的 Story，撤销需要服务端口。')
  }
  const service = await deps.supervisor.inspect(cron.storyId)
  if (!service || service.status !== 'running') {
    throw new RouteError(409, 'STORY_SERVICE_UNAVAILABLE', '该任务所属服务当前不可用，无法撤销。')
  }
  return { port: service.port, storyId: cron.storyId }
}
