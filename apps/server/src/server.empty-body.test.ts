import { describe, expect, it } from 'vitest'
import { buildServer } from './server.js'

/** 测试用访问令牌 */
const accessToken = 'a'.repeat(32)

/**
 * 校验无 body 的写请求不会被 Fastify 的 JSON 解析器直接拒绝。
 * 背景：前端 apiRequest 曾经对无参数写操作也声明 application/json，
 * Fastify 返回 400 FST_ERR_CTP_EMPTY_JSON_BODY，表现就是「点一下按钮、loading 一闪、没有任何效果」。
 */
describe('empty JSON body handling', () => {
  it('accepts a POST with JSON content type but no body', async () => {
    const app = buildServer({
      token: accessToken,
      logger: false,
      snapshotProvider: async () => ({
        snapshotAt: '2026-01-01T00:00:00.000Z',
        channels: {},
        requirements: [],
        bugs: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        inbox: [],
        jobs: [],
        crons: [],
        builds: [],
        mergeRequests: [],
      }),
    })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/stories/STORY-1/service',
        headers: {
          'x-devtask-token': accessToken,
          'content-type': 'application/json',
        },
      })
      // 没有工作区时应返回业务 409，而不是解析层的 400
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code: 'STORY_WORKSPACE_UNAVAILABLE' } })
    } finally {
      await app.close()
    }
  })

  it('still reports malformed JSON bodies as errors', async () => {
    const app = buildServer({
      token: accessToken,
      logger: false,
      snapshotProvider: async () => ({
        snapshotAt: '2026-01-01T00:00:00.000Z',
        channels: {},
        requirements: [],
        bugs: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        inbox: [],
        jobs: [],
        crons: [],
        builds: [],
        mergeRequests: [],
      }),
    })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/crons',
        headers: {
          'x-devtask-token': accessToken,
          'content-type': 'application/json',
        },
        payload: '{not-json',
      })
      expect(response.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
