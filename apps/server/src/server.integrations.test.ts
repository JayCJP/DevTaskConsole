import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from './server.js'
import { DevOpsAdapter } from './integrations/devops.js'
import { GitLabAdapter } from './integrations/gitlab.js'
import { WorkspaceInitializer } from './workspaces/initializer.js'
import { StoryServiceSupervisor } from './services/story-service-supervisor.js'
import { AuditLog } from './services/audit-log.js'
import { CronMappingStore } from './aggregator/cron-data.js'

const accessToken = 'c'.repeat(64)
let server: ReturnType<typeof buildServer> | undefined
let dataDirectory: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

describe('read-only integration API', () => {
  it('stores only explicit cron task owner mappings for the associated Story', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-cron-api-'))
    const app = buildServer({
      token: accessToken,
      logger: false,
      cronMappingStore: new CronMappingStore(dataDirectory),
      // 审计流水必须落在临时目录，避免测试写入真实数据目录
      auditLog: new AuditLog(dataDirectory),
      snapshotProvider: async () => ({
        snapshotAt: '2026-01-01T00:00:00.000Z',
        channels: {},
        requirements: [{ storyId: 'STORY-1', title: 'Requirement' }],
        bugs: [],
        harnessBugs: [],
        openQuestions: [],
        harnessActive: [],
        inbox: [],
        jobs: [],
        crons: [{ id: 'task-1', storyId: 'STORY-1', storyTitle: 'Requirement', cron: '7 * * * *' }],
        builds: [],
        mergeRequests: [],
      }),
    })
    server = app

    const unauthorized = await app.inject({
      method: 'PUT',
      url: '/api/v1/crons/task-1/mapping',
      payload: { storyId: 'STORY-1', ownerSessionId: 'owner-1', mode: 'query_only' },
    })
    // 默认要求校验 owner 会话归属；该用例没有启动服务，因此先断言拒绝，再显式关闭校验
    const unverified = await app.inject({
      method: 'PUT',
      url: '/api/v1/crons/task-1/mapping',
      headers: { 'x-devtask-token': accessToken },
      payload: { storyId: 'STORY-1', ownerSessionId: 'owner-1', mode: 'query_only' },
    })
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/crons/task-1/mapping',
      headers: { 'x-devtask-token': accessToken },
      payload: { storyId: 'STORY-1', ownerSessionId: 'owner-1', mode: 'query_only', verify: false },
    })
    const mismatch = await app.inject({
      method: 'PUT',
      url: '/api/v1/crons/task-1/mapping',
      headers: { 'x-devtask-token': accessToken },
      payload: { storyId: 'STORY-2', ownerSessionId: 'owner-1', mode: 'query_fix', verify: false },
    })

    expect(unauthorized.statusCode).toBe(401)
    expect(unverified.statusCode).toBe(409)
    expect(unverified.json()).toMatchObject({ error: { code: 'STORY_SERVICE_NOT_STARTED' } })
    expect(saved.json()).toEqual({
      taskId: 'task-1',
      storyId: 'STORY-1',
      ownerSessionId: 'owner-1',
      mode: 'query_only',
    })
    expect(mismatch.statusCode).toBe(404)
  })

  it('exposes DevOps group discovery behind local authentication', async () => {
    const adapter = new DevOpsAdapter()
    adapter.getGroups = async () => [{ name: 'Frontend' }]
    const app = buildServer({ token: accessToken, logger: false, devOpsAdapter: adapter })
    server = app

    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/devops/groups' })
    const authorized = await app.inject({
      method: 'GET',
      url: '/api/v1/devops/groups',
      headers: { 'x-devtask-token': accessToken },
    })

    expect(unauthorized.statusCode).toBe(401)
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual([{ name: 'Frontend' }])
  })

  it('validates project search inputs and returns only mapped merge request fields', async () => {
    const adapter = new GitLabAdapter()
    adapter.findProjects = async (search) => [{ id: 5, pathWithNamespace: `group/${search}` }]
    adapter.listMergeRequests = async (_projectId, sourceBranch) => [{
      projectId: 5,
      id: '10',
      title: 'Update login flow',
      sourceBranch,
      targetBranch: 'dev',
      state: 'opened',
    }]
    adapter.getMergeRequestDetails = async (projectId, iid) => ({
      approvals: { approved: true, approvedBy: ['Reviewer'] },
      changesCount: 2,
      changedFiles: [`project-${projectId}-${iid}.ts`],
    })
    const app = buildServer({ token: accessToken, logger: false, gitLabAdapter: adapter })
    server = app

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/gitlab/projects?search=',
      headers: { 'x-devtask-token': accessToken },
    })
    const projects = await app.inject({
      method: 'GET',
      url: '/api/v1/gitlab/projects?search=console',
      headers: { 'x-devtask-token': accessToken },
    })
    const mergeRequests = await app.inject({
      method: 'GET',
      url: '/api/v1/gitlab/projects/5/merge-requests?sourceBranch=feat%2Fworkspace',
      headers: { 'x-devtask-token': accessToken },
    })
    const mergeRequestDetails = await app.inject({
      method: 'GET',
      url: '/api/v1/gitlab/projects/5/merge-requests/10',
      headers: { 'x-devtask-token': accessToken },
    })

    expect(invalid.statusCode).toBe(400)
    expect(projects.json()).toEqual([{ id: 5, pathWithNamespace: 'group/console' }])
    expect(mergeRequests.json()).toEqual([{
      projectId: 5,
      id: '10',
      title: 'Update login flow',
      sourceBranch: 'feat/workspace',
      targetBranch: 'dev',
      state: 'opened',
    }])
    expect(mergeRequestDetails.json()).toEqual({
      approvals: { approved: true, approvedBy: ['Reviewer'] },
      changesCount: 2,
      changedFiles: ['project-5-10.ts'],
    })
  })

  it('protects workspace previews and returns asynchronous initialization status', async () => {
    const initializer = new WorkspaceInitializer()
    const job = {
      id: '00e3f7b8-5cc0-444e-9ca0-708dc19324b2',
      workspaceName: 'feature-one',
      status: 'running' as const,
      stage: 'worktree' as const,
      logs: ['Starting worktree stage.'],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      exitCode: null,
    }
    initializer.preview = async () => ({ logs: ['DryRun preview'], exitCode: 0 })
    initializer.start = async () => job
    initializer.getJob = async (id) => id === job.id ? job : undefined
    const app = buildServer({ token: accessToken, logger: false, workspaceInitializer: initializer })
    server = app

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/initialize/preview',
      payload: { workspaceName: 'feature-one', repositoryNames: ['repo-one'] },
    })
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/initialize/preview',
      headers: { 'x-devtask-token': accessToken },
      payload: { workspaceName: 'feature-one', repositoryNames: ['repo-one'] },
    })
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/initialize',
      headers: { 'x-devtask-token': accessToken },
      payload: { workspaceName: 'feature-one', repositoryNames: ['repo-one'] },
    })
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/initialize/${job.id}`,
      headers: { 'x-devtask-token': accessToken },
    })

    expect(unauthorized.statusCode).toBe(401)
    expect(preview.json()).toEqual({ logs: ['DryRun preview'], exitCode: 0 })
    expect(started.statusCode).toBe(202)
    expect(status.json()).toMatchObject({ id: job.id, status: 'running', logs: ['Starting worktree stage.'] })
  })

  it('starts a Story service only for the workspace associated by the server snapshot', async () => {
    let received: { storyId: string; cwd: string; root: string } | undefined
    const supervisor = new StoryServiceSupervisor({
      dataDirectory: 'C:\\devtask-test-data',
      portStart: 60270,
      portEnd: 60270,
    })
    supervisor.ensureRunning = async (storyId, cwd, root) => {
      received = { storyId, cwd, root }
      return {
        storyId,
        cwd,
        port: 60270,
        pid: 9876,
        status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    }
    const app = buildServer({
      token: accessToken,
      logger: false,
      workspacesRoot: 'C:\\workspaces',
      storyServiceSupervisor: supervisor,
      snapshotProvider: async () => ({
        snapshotAt: '2026-01-01T00:00:00.000Z',
        channels: {},
        requirements: [{ storyId: 'STORY-1', title: 'Requirement', workspacePath: 'work-one\\repo-a' }],
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
    server = app

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/service',
      headers: { 'x-devtask-token': accessToken },
      payload: { cwd: 'C:\\sensitive\\arbitrary-path', port: 1 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      storyId: 'STORY-1',
      // 端口由服务注册表分配，前端需要它展示「端口就绪」状态
      port: response.json().port,
      cwd: 'C:\\workspaces\\work-one\\repo-a',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(received).toEqual({
      storyId: 'STORY-1',
      cwd: 'C:\\workspaces\\work-one\\repo-a',
      root: 'C:\\workspaces',
    })
  })

  it('rejects invalid workspace names before scanning or executing the initializer', async () => {
    const app = buildServer({ token: accessToken, logger: false, workspaceInitializer: new WorkspaceInitializer() })
    server = app

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/initialize/preview',
      headers: { 'x-devtask-token': accessToken },
      payload: { workspaceName: '..', repositoryNames: ['repo-one'] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('INVALID_WORKSPACE_REQUEST')
  })
})
