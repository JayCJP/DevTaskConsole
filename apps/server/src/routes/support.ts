import type { FastifyReply, FastifyRequest } from 'fastify'
import { CodeBuddyApiError } from '../services/codebuddy-api.js'
import { CronDispatchConflictError } from '../services/cron-dispatch.js'
import { StoryServiceRemoveError, StoryServiceStopError } from '../services/story-service-supervisor.js'

/**
 * 携带 HTTP 状态与错误码的路由错误。
 * 用于把领域判断（端口未就绪、owner 校验失败、任务不存在）直接映射为可读响应，
 * 而不是一律退化成 503。
 */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

/**
 * 统一的参数错误响应。
 * @param reply Fastify 响应对象
 * @returns 已发送的响应
 */
export function invalidParameters(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: { code: 'INVALID_PARAMETERS', message: 'The request parameters are invalid.' },
  })
}

/**
 * 统一映射控制台写操作与上游调用的错误。
 * 上游 4xx 会原样透出（400/404），其余上游错误按 502 处理，
 * 本地服务不可用按 503 处理，冲突类错误按 409 处理。
 * @param request Fastify 请求对象，用于写日志
 * @param reply Fastify 响应对象
 * @param error 原始错误
 * @returns 已发送的响应；连接已断开时返回 undefined
 */
export function controlError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (reply.raw.destroyed) return undefined
  if (error instanceof RouteError) {
    request.log.warn({ code: error.code }, 'Control request rejected')
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
  }
  if (
    error instanceof StoryServiceStopError
    || error instanceof StoryServiceRemoveError
    || error instanceof CronDispatchConflictError
  ) {
    const code = error instanceof StoryServiceStopError
      ? 'STORY_SERVICE_STOP_FAILED'
      : error instanceof StoryServiceRemoveError
        ? 'STORY_SERVICE_REMOVE_FAILED'
        : 'CRON_DISPATCH_CONFLICT'
    request.log.warn({ code }, 'Control request rejected')
    return reply.code(409).send({ error: { code, message: error.message } })
  }
  if (error instanceof CodeBuddyApiError) {
    const status = error.status === 400 ? 400 : error.status === 404 ? 404 : 502
    const code = error.status === 400
      ? 'CODEBUDDY_INVALID_REQUEST'
      : error.status === 404
        ? 'CODEBUDDY_NOT_FOUND'
        : 'CODEBUDDY_UPSTREAM_ERROR'
    request.log.error({ code, upstreamStatus: error.status }, 'CodeBuddy API request failed')
    return reply.code(status).send({ error: { code, message: error.message } })
  }
  request.log.error({ code: 'CONTROL_REQUEST_FAILED' }, 'Control request failed')
  return reply.code(503).send({
    error: {
      code: 'CONTROL_REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'The control request failed.',
    },
  })
}
