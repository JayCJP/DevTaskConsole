import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from './server.js'
import { DevOpsAdapter } from './integrations/devops.js'
import { AuditLog } from './services/audit-log.js'

const accessToken = 'c'.repeat(64)
let server: ReturnType<typeof buildServer> | undefined
let dataDirectory: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/**
 * 构造一份最小快照桩，可指定 Harness 进行中的阶段。
 * @param phase 进行中的 Phase；不传表示无门控
 * @returns 快照对象
 */
function snapshotWithPhase(phase?: number) {
  return {
    snapshotAt: '2026-01-01T00:00:00.000Z',
    channels: { devops: { ok: true, fetchedAt: '2026-01-01T00:00:00.000Z', stale: false } },
    requirements: [],
    bugs: [],
    harnessBugs: [],
    openQuestions: [],
    harnessActive:
      phase === undefined
        ? []
        : [
            {
              storyId: 'STORY-1',
              title: 'Story',
              phase,
              workspacePath: 'ws',
            },
          ],
    inbox: [],
    jobs: [],
    crons: [],
  }
}

/** 构造带钩子的 DevOpsAdapter 桩，记录 deployMultiple 的入参 */
function devOpsStub() {
  const adapter = new DevOpsAdapter()
  const deployMultiple = vi.fn(
    async (_input: { urls: string[]; env: string; force?: string; timeout?: number }) => ({
      taskId: 'deploy-1',
    }),
  )
  adapter.deployMultiple = deployMultiple
  return { adapter, deployMultiple }
}

/** 创建带桩的测试服务器 */
async function makeApp(phase: number | undefined, stub = devOpsStub()) {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-deploy-'))
  const audit = new AuditLog(dataDirectory)
  const app = buildServer({
    token: accessToken,
    logger: false,
    devOpsAdapter: stub.adapter,
    auditLog: audit,
    snapshotProvider: async () => snapshotWithPhase(phase),
  })
  server = app
  return { app, audit, ...stub }
}

describe('batch deploy API', () => {
  it('rejects unsupported environments and malformed urls', async () => {
    const { app, deployMultiple } = await makeApp(undefined)

    const badEnv = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/deploy-multiple',
      headers: { 'x-devtask-token': accessToken },
      payload: { urls: ['https://artifacts.example/a.zip'], env: 'prod' },
    })
    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/deploy-multiple',
      headers: { 'x-devtask-token': accessToken },
      payload: { urls: ['not-a-url'], env: 'dev' },
    })

    expect(badEnv.statusCode).toBe(400)
    expect(badUrl.statusCode).toBe(400)
    expect(deployMultiple).not.toHaveBeenCalled()
  })

  it('rejects every deploy while Harness is in Phase 4-6', async () => {
    const { app, deployMultiple } = await makeApp(5)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/deploy-multiple',
      headers: { 'x-devtask-token': accessToken },
      payload: { urls: ['https://artifacts.example/a.zip'], env: 'dev' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'HARNESS_PHASE_GATE', phase: 5 } })
    expect(deployMultiple).not.toHaveBeenCalled()
  })

  it('accepts supported envs, passes urls through and records audit', async () => {
    const { app, audit, deployMultiple } = await makeApp(undefined)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/deploy-multiple',
      headers: { 'x-devtask-token': accessToken },
      payload: {
        urls: ['https://artifacts.example/a.zip', 'https://artifacts.example/b.zip'],
        env: 'pre-txnj',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      env: 'pre-txnj',
      urls: ['https://artifacts.example/a.zip', 'https://artifacts.example/b.zip'],
      force: '0',
      timeout: 300,
      raw: { taskId: 'deploy-1' },
    })
    expect(deployMultiple).toHaveBeenCalledWith({
      urls: ['https://artifacts.example/a.zip', 'https://artifacts.example/b.zip'],
      env: 'pre-txnj',
      force: '0',
      timeout: 300,
    })
    expect((await audit.list()).some((entry) => entry.action === 'deploy.multiple')).toBe(true)
  })

  it('maps expired DevOps session to 403', async () => {
    const stub = devOpsStub()
    stub.deployMultiple.mockRejectedValueOnce(new Error('DevOps session expired (HTTP 403).'))
    const { app } = await makeApp(undefined, stub)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/deploy-multiple',
      headers: { 'x-devtask-token': accessToken },
      payload: { urls: ['https://artifacts.example/a.zip'], env: 'dev' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'DEVOPS_SESSION_EXPIRED' } })
  })
})
