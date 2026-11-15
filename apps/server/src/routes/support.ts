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
    const mapped = mapUpstreamStatus(error.status)
    request.log.error({ code: mapped.code, upstreamStatus: error.status }, 'CodeBuddy API request failed')
    return reply.code(mapped.status).send({
      error: {
        code: mapped.code,
        message: mapped.hint ? `${error.message} ${mapped.hint}` : error.message,
      },
    })
  }
  request.log.error({ code: 'CONTROL_REQUEST_FAILED' }, 'Control request failed')
  return reply.code(503).send({
    error: {
      code: 'CONTROL_REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'The control request failed.',
    },
  })
}

/**
 * 把 CodeBuddy 上游状态码映射为本站响应。
 * 鉴权失败与限流必须可区分：一个要重新配置凭据，一个只需要稍后重试；
 * 统一报 502 会让用户无从判断该做什么。
 * @param upstreamStatus 上游 HTTP 状态码
 * @returns 对外状态码、错误码与可选的中文处置建议
 */
function mapUpstreamStatus(upstreamStatus: number): {
  status: number
  code: string
  hint?: string
} {
  if (upstreamStatus === 400) return { status: 400, code: 'CODEBUDDY_INVALID_REQUEST' }
  if (upstreamStatus === 404) return { status: 404, code: 'CODEBUDDY_NOT_FOUND' }
  if (upstreamStatus === 409) {
    return { status: 409, code: 'CODEBUDDY_CONFLICT', hint: '上游拒绝了本次变更，任务状态可能已被其它操作修改。' }
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      status: 502,
      code: 'CODEBUDDY_UNAUTHORIZED',
      hint: '上游拒绝访问，请检查 CodeBuddy 实例的访问凭据或权限。',
    }
  }
  if (upstreamStatus === 429) {
    return {
      status: 503,
      code: 'CODEBUDDY_RATE_LIMITED',
      hint: '上游限流，请稍后重试。',
    }
  }
  return { status: 502, code: 'CODEBUDDY_UPSTREAM_ERROR' }
}
