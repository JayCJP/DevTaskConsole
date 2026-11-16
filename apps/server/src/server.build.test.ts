import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from './server.js'
import { DevOpsAdapter } from './integrations/devops.js'
import { AuditLog } from './services/audit-log.js'

const accessToken = 'b'.repeat(64)
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
    harnessActive: phase === undefined ? [] : [{
      storyId: 'STORY-1',
      title: 'Story',
      phase,
      workspacePath: 'ws',
    }],
    inbox: [],
    jobs: [],
    crons: [],
  }
}

/** 构造带钩子的 DevOpsAdapter 桩，记录 triggerBuild 的入参 */
function devOpsStub() {
  const adapter = new DevOpsAdapter()
  const triggerBuild = vi.fn(async (_input: {
    group: string
    app: string
    branch: string
    buildOther: string
    env?: string
  }) => ({ number: '9001' }))
  adapter.triggerBuild = triggerBuild
  return { adapter, triggerBuild }
}

describe('trigger build API', () => {
  it('rejects every build while Harness is in Phase 4-6', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-build-gate-'))
    const { adapter, triggerBuild } = devOpsStub()
    const app = buildServer({
      token: accessToken,
      logger: false,
      devOpsAdapter: adapter,
      auditLog: new AuditLog(dataDirectory),
      snapshotProvider: async () => snapshotWithPhase(5),
    })
    server = app

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/build',
      headers: { 'x-devtask-token': accessToken },
      payload: { group: 'JenkinsFrontweb', app: 'education', env: 'dev' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'HARNESS_PHASE_GATE', phase: 5 } })
    expect(triggerBuild).not.toHaveBeenCalled()
  })

  it('uses fixed dev mapping and sends env only for dev', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-build-dev-'))
    const { adapter, triggerBuild } = devOpsStub()
    const audit = new AuditLog(dataDirectory)
    const app = buildServer({
      token: accessToken,
      logger: false,
      devOpsAdapter: adapter,
      auditLog: audit,
      snapshotProvider: async () => snapshotWithPhase(),
    })
    server = app

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/build',
      headers: { 'x-devtask-token': accessToken },
      payload: { group: 'JenkinsFrontweb', app: 'education', env: 'dev' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ env: 'dev', branch: 'origin/dev', buildOther: 'dev', number: '9001' })
    expect(triggerBuild).toHaveBeenCalledWith({
      group: 'JenkinsFrontweb',
      app: 'education',
      branch: 'origin/dev',
      buildOther: 'dev',
      env: 'dev',
    })
    expect((await audit.list()).some((entry) => entry.action === 'build.trigger')).toBe(true)
  })

  it('uses fixed prod mapping: build_other=build, branch=origin/master, no env field', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-build-prod-'))
    const { adapter, triggerBuild } = devOpsStub()
    const app = buildServer({
      token: accessToken,
      logger: false,
      devOpsAdapter: adapter,
      auditLog: new AuditLog(dataDirectory),
      snapshotProvider: async () => snapshotWithPhase(),
    })
    server = app

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devops/build',
      headers: { 'x-devtask-token': accessToken },
      payload: { group: 'JenkinsFrontweb', app: 'education', env: 'prod' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ env: 'prod', branch: 'origin/master', buildOther: 'build' })
    expect(triggerBuild).toHaveBeenCalledWith({
      group: 'JenkinsFrontweb',
      app: 'education',
      branch: 'origin/master',
      buildOther: 'build',
    })
    expect(triggerBuild.mock.calls[0]?.[0]).not.toHaveProperty('env')
  })
})
