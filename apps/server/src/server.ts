import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  applicationMappingSchema,
  jobCreateRequestSchema,
  jobRenameRequestSchema,
  jobReplyRequestSchema,
  jobSchema,
  loginRequestSchema,
  resumableSessionSchema,
  snapshotSchema,
  type Snapshot,
} from '@devtask/shared'
import { z } from 'zod'
import { buildSnapshot, getWorkspacesRoot } from './aggregator/snapshot.js'
import { DevOpsAdapter } from './integrations/devops.js'
import { GitLabAdapter } from './integrations/gitlab.js'
import { ApplicationMappingStore } from './integrations/application-mappings.js'
import { CronMappingStore } from './aggregator/cron-data.js'
import { mcpClientRegistry } from './integrations/mcp-client.js'
import { getDataDirectory, loadOrCreateToken, tokenMatches } from './security/token-store.js'
import { listRepositoryCandidates } from './workspaces/repository-candidates.js'
import {
  WorkspaceConflictError,
  WorkspaceDependencyError,
  WorkspaceInitializer,
  WorkspaceInputError,
} from './workspaces/initializer.js'
import { StoryServiceSupervisor, type StoryService } from './services/story-service-supervisor.js'
import { CodeBuddyApi, CodeBuddyApiError } from './services/codebuddy-api.js'

export interface ServerOptions {
  token: string
  logger?: boolean
  snapshotProvider?: () => Promise<Snapshot>
  devOpsAdapter?: DevOpsAdapter
  gitLabAdapter?: GitLabAdapter
  applicationMappingStore?: ApplicationMappingStore
  cronMappingStore?: CronMappingStore
  workspaceInitializer?: WorkspaceInitializer
  storyServiceSupervisor?: StoryServiceSupervisor
  workspacesRoot?: string
}

const storyIdSchema = z.string().min(1).max(200)
const jobIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true })
  const devOps = options.devOpsAdapter ?? new DevOpsAdapter()
  const gitLab = options.gitLabAdapter ?? new GitLabAdapter()
  const applicationMappings = options.applicationMappingStore ?? new ApplicationMappingStore()
  const cronMappings = options.cronMappingStore ?? new CronMappingStore()
  const workspaceInitializer = options.workspaceInitializer ?? new WorkspaceInitializer()
  const storyServiceSupervisor = options.storyServiceSupervisor ?? new StoryServiceSupervisor()
  const codeBuddyApi = new CodeBuddyApi()
  const workspacesRoot = options.workspacesRoot ?? getWorkspacesRoot()
  app.addHook('onClose', async () => {
    await workspaceInitializer.flush()
    await mcpClientRegistry.close()
  })
  const snapshotProvider = options.snapshotProvider ?? buildSnapshot
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  const ensureStoryService = async (storyId: string): Promise<StoryService> => {
    const snapshot = await snapshotProvider()
    const requirement = snapshot.requirements.find((item) => item.storyId === storyId)
    if (!requirement?.workspacePath) {
      throw new StoryWorkspaceUnavailableError()
    }
    return storyServiceSupervisor.ensureRunning(
      storyId,
      resolve(workspacesRoot, requirement.workspacePath),
      workspacesRoot,
    )
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/auth/login') {
      return
    }
    if (!request.url.startsWith('/api/')) {
      return
    }

    const candidate = request.headers['x-devtask-token']
    if (typeof candidate !== 'string' || !tokenMatches(candidate, options.token)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid local access token is required.' } })
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body)
    if (!parsed.success || !tokenMatches(parsed.data.token, options.token)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'The access token is invalid.' } })
    }
    return { authenticated: true }
  })

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    service: 'devtask-console',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/v1/workspaces/candidates', async (request, reply) => {
    try {
      return await listRepositoryCandidates()
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN'
      request.log.error({ code }, 'Unable to list repository candidates')
      return reply.code(503).send({
        error: {
          code: 'SOURCE_ROOT_UNAVAILABLE',
          message: 'The configured source repository root is unavailable.',
        },
      })
    }
  })

  app.get('/api/v1/stories/:storyId/service', async (request, reply) => {
    const params = z.object({ storyId: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const service = await storyServiceSupervisor.inspect(params.data.storyId)
    if (!service) return reply.code(404).send({
      error: { code: 'STORY_SERVICE_NOT_FOUND', message: 'No CodeBuddy service has been assigned to this Story.' },
    })
    return publicStoryService(service)
  })

  app.get('/api/v1/stories/services', async () => {
    const services = await storyServiceSupervisor.inspectAll()
    return services.map(publicStoryService)
  })

  app.post('/api/v1/stories/:storyId/service', async (request, reply) => {
    const params = z.object({ storyId: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const snapshot = await snapshotProvider()
      const requirement = snapshot.requirements.find((item) => item.storyId === params.data.storyId)
      if (!requirement?.workspacePath) {
        return reply.code(409).send({
          error: {
            code: 'STORY_WORKSPACE_UNAVAILABLE',
            message: 'This Story has no associated workspace; initialize and associate its workspace first.',
          },
        })
      }
      const service = await storyServiceSupervisor.ensureRunning(
        requirement.storyId,
        resolve(workspacesRoot, requirement.workspacePath),
        workspacesRoot,
      )
      return reply.code(200).send(publicStoryService(service))
    } catch (error) {
      request.log.error({ code: 'STORY_SERVICE_START_FAILED' }, 'Unable to start Story CodeBuddy service')
      return reply.code(503).send({
        error: {
          code: 'STORY_SERVICE_START_FAILED',
          message: error instanceof Error ? error.message : 'Unable to start the Story CodeBuddy service.',
        },
      })
    }
  })

  app.get('/api/v1/stories/:storyId/jobs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await storyServiceSupervisor.inspect(params.data.storyId)
      if (!service) return []
      if (service.status !== 'running') {
        return reply.code(503).send({
          error: {
            code: 'STORY_SERVICE_UNAVAILABLE',
            message: service.error ?? 'Start or recover the Story service before listing jobs.',
          },
        })
      }
      const query = new URLSearchParams({ all: '1', cwd: service.cwd })
      const result = await codeBuddyApi.request(service.port, `/api/v1/jobs?${query}`, 'GET')
      const parsed = jobSchema.array().safeParse(result)
      if (!parsed.success) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid jobs response.')
      return parsed.data.map((job) => ({ ...job, storyId: params.data.storyId }))
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    const body = jobCreateRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const result = await codeBuddyApi.request(service.port, '/api/v1/jobs', 'POST', {
        ...body.data,
        cwd: service.cwd,
      })
      return reply.code(201).send(result)
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/:jobId/transcript', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/transcript`,
        'GET',
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/:jobId/stream', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const lastEventIdHeader = request.headers['last-event-id']
    if (
      Array.isArray(lastEventIdHeader)
      || (lastEventIdHeader !== undefined && (lastEventIdHeader.length > 500 || /[\r\n]/.test(lastEventIdHeader)))
    ) return invalidParameters(reply)
    const controller = new AbortController()
    reply.raw.once('close', () => controller.abort())
    try {
      const service = await ensureStoryService(params.data.storyId)
      const upstream = await codeBuddyApi.openStream(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/stream`,
        controller.signal,
        lastEventIdHeader,
      )
      if (!upstream.body) throw new CodeBuddyApiError(502, 'CodeBuddy returned an empty event stream.')
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      await pipeline(Readable.from(upstream.body), reply.raw)
    } catch (error) {
      if (reply.sent) return
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/reply', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    const body = jobReplyRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/reply`,
        'POST',
        body.data,
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/stop', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}/stop`,
      method: 'POST',
    }), ensureStoryService, codeBuddyApi)
  })

  app.post('/api/v1/stories/:storyId/jobs/:jobId/respawn', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}/respawn`,
      method: 'POST',
    }), ensureStoryService, codeBuddyApi)
  })

  app.delete('/api/v1/stories/:storyId/jobs/:jobId', async (request, reply) => {
    return relayCodeBuddyJob(request, reply, params => ({
      serviceId: params.storyId,
      path: `/api/v1/jobs/${encodeURIComponent(params.jobId)}`,
      method: 'DELETE',
    }), ensureStoryService, codeBuddyApi)
  })

  app.patch('/api/v1/stories/:storyId/jobs/:jobId/name', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
    const body = jobRenameRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      return await codeBuddyApi.request(
        service.port,
        `/api/v1/jobs/${encodeURIComponent(params.data.jobId)}/name`,
        'PATCH',
        body.data,
      )
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/stories/:storyId/jobs/resumable', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const query = new URLSearchParams({ cwd: service.cwd })
      const result = await codeBuddyApi.request(service.port, `/api/v1/jobs/resumable?${query}`, 'GET')
      const parsed = resumableSessionSchema.array().safeParse(result)
      if (!parsed.success) throw new CodeBuddyApiError(502, 'CodeBuddy returned an invalid resumable sessions response.')
      return parsed.data
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.post('/api/v1/stories/:storyId/jobs/resume', async (request, reply) => {
    const params = z.object({ storyId: storyIdSchema }).safeParse(request.params)
    const body = z.object({ sessionId: z.string().min(1).max(200) }).safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const service = await ensureStoryService(params.data.storyId)
      const query = new URLSearchParams({ cwd: service.cwd })
      const resumable = await codeBuddyApi.request(service.port, `/api/v1/jobs/resumable?${query}`, 'GET')
      if (!isResumableSession(resumable, body.data.sessionId)) {
        return reply.code(409).send({
          error: {
            code: 'SESSION_NOT_RESUMABLE_FOR_STORY',
            message: 'The requested session is not listed as resumable in this Story workspace.',
          },
        })
      }
      return reply.code(201).send(await codeBuddyApi.request(
        service.port,
        '/api/v1/jobs/resume',
        'POST',
        body.data,
      ))
    } catch (error) {
      return codeBuddyError(request, reply, error)
    }
  })

  app.get('/api/v1/application-mappings', async (request, reply) => {
    try {
      return await applicationMappings.list()
    } catch (error) {
      request.log.error({ code: 'APPLICATION_MAPPING_READ_FAILED' }, 'Unable to read application mappings')
      return reply.code(503).send({
        error: {
          code: 'APPLICATION_MAPPING_READ_FAILED',
          message: error instanceof Error ? error.message : 'Unable to read application mappings.',
        },
      })
    }
  })

  app.put('/api/v1/application-mappings', async (request, reply) => {
    const parsed = applicationMappingSchema.safeParse(request.body)
    if (!parsed.success) return invalidParameters(reply)
    try {
      return await applicationMappings.upsert(parsed.data)
    } catch (error) {
      request.log.error({ code: 'APPLICATION_MAPPING_WRITE_FAILED' }, 'Unable to save application mapping')
      return reply.code(503).send({
        error: {
          code: 'APPLICATION_MAPPING_WRITE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to save application mapping.',
        },
      })
    }
  })

  app.post('/api/v1/workspaces/initialize/preview', async (request, reply) => {
    try {
      return await workspaceInitializer.preview(request.body)
    } catch (error) {
      return workspaceInitializationError(request, reply, error)
    }
  })

  app.post('/api/v1/workspaces/initialize', async (request, reply) => {
    try {
      const job = await workspaceInitializer.start(request.body)
      return reply.code(202).send(job)
    } catch (error) {
      return workspaceInitializationError(request, reply, error)
    }
  })

  app.get('/api/v1/workspaces/initialize/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    const job = await workspaceInitializer.getJob(params.data.jobId)
    if (!job) return reply.code(404).send({
      error: { code: 'WORKSPACE_JOB_NOT_FOUND', message: 'Workspace initialization job was not found.' },
    })
    return job
  })

  app.get('/api/v1/devops/groups', async (request, reply) => {
    return relayRead(request, reply, 'DevOps', () => devOps.getGroups())
  })

  app.get('/api/v1/devops/groups/:group/applications', async (request, reply) => {
    const params = z.object({ group: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () => devOps.getApplications(params.data.group))
  })

  app.get('/api/v1/devops/apps/:app/branches', async (request, reply) => {
    const params = z.object({ app: z.string().min(1).max(200) }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () => devOps.getBranches(params.data.app))
  })

  app.get('/api/v1/devops/apps/:app/builds', async (request, reply) => {
    const params = z.object({ app: z.string().min(1).max(200) }).safeParse(request.params)
    const query = z.object({
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(request.query)
    if (!params.success || !query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'DevOps', () =>
      devOps.getBuildRecords(params.data.app, query.data.pageNo, query.data.pageSize))
  })

  app.get('/api/v1/gitlab/projects', async (request, reply) => {
    const query = z.object({ search: z.string().min(1).max(200) }).safeParse(request.query)
    if (!query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () => gitLab.findProjects(query.data.search))
  })

  app.put('/api/v1/crons/:taskId/mapping', async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1).max(200) }).safeParse(request.params)
    const body = z.object({
      storyId: storyIdSchema,
      ownerSessionId: z.string().trim().min(1).max(200),
      mode: z.enum(['query_only', 'query_fix']),
    }).safeParse(request.body)
    if (!params.success || !body.success) return invalidParameters(reply)
    try {
      const snapshot = await snapshotProvider()
      const task = snapshot.crons.find((item) => item.id === params.data.taskId)
      if (!task || task.storyId !== body.data.storyId) {
        return reply.code(404).send({
          error: { code: 'CRON_TASK_NOT_FOUND', message: 'The task is not associated with the selected Story.' },
        })
      }
      const mapping = { taskId: task.id, ...body.data }
      await cronMappings.save(mapping)
      return mapping
    } catch (error) {
      request.log.error({ code: 'CRON_MAPPING_SAVE_FAILED' }, 'Unable to save cron owner mapping')
      return reply.code(503).send({
        error: {
          code: 'CRON_MAPPING_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to save cron owner mapping.',
        },
      })
    }
  })

  app.get('/api/v1/gitlab/projects/:projectId/merge-requests', async (request, reply) => {
    const params = z.object({ projectId: z.coerce.number().int().positive() }).safeParse(request.params)
    const query = z.object({ sourceBranch: z.string().min(1).max(250) }).safeParse(request.query)
    if (!params.success || !query.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () =>
      gitLab.listMergeRequests(params.data.projectId, query.data.sourceBranch))
  })

  app.get('/api/v1/gitlab/projects/:projectId/merge-requests/:iid', async (request, reply) => {
    const params = z.object({
      projectId: z.coerce.number().int().positive(),
      iid: z.string().min(1).max(100),
    }).safeParse(request.params)
    if (!params.success) return invalidParameters(reply)
    return relayRead(request, reply, 'GitLab', () =>
      gitLab.getMergeRequestDetails(params.data.projectId, params.data.iid))
  })

  app.get('/api/v1/snapshot', async (request, reply) => {
    const snapshot = await snapshotProvider()
    const parsed = snapshotSchema.safeParse(snapshot)
    if (!parsed.success) {
      request.log.error({ issues: parsed.error.issues }, 'Snapshot validation failed')
      return reply.code(500).send({
        error: {
          code: 'INVALID_SNAPSHOT',
          message: 'The data aggregator returned an invalid snapshot.',
        },
      })
    }
    return parsed.data
  })

  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API route not found.' } })
      }
      return reply.type('text/html').sendFile('index.html')
    })
  }

  return app
}

function publicStoryService(service: StoryService): {
  storyId: string
  status: StoryService['status']
  updatedAt: string
  error?: string
} {
  return {
    storyId: service.storyId,
    status: service.status,
    updatedAt: service.updatedAt,
    ...(service.error ? { error: service.error } : {}),
  }
}

async function relayCodeBuddyJob(
  request: FastifyRequest,
  reply: FastifyReply,
  buildTarget: (params: { storyId: string; jobId: string }) => {
    serviceId: string
    path: string
    method: 'POST' | 'DELETE'
  },
  ensureStoryService: (storyId: string) => Promise<StoryService>,
  api: CodeBuddyApi,
): Promise<unknown> {
  const parsed = z.object({ storyId: storyIdSchema, jobId: jobIdSchema }).safeParse(request.params)
  if (!parsed.success) return invalidParameters(reply)
  try {
    const target = buildTarget(parsed.data)
    const service = await ensureStoryService(target.serviceId)
    return await api.request(service.port, target.path, target.method)
  } catch (error) {
    return codeBuddyError(request, reply, error)
  }
}

function codeBuddyError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (reply.raw.destroyed) return undefined
  if (error instanceof StoryWorkspaceUnavailableError) {
    return reply.code(409).send({
      error: { code: 'STORY_WORKSPACE_UNAVAILABLE', message: error.message },
    })
  }
  const isUpstream = error instanceof CodeBuddyApiError
  const status = isUpstream ? 502 : 503
  request.log.error({
    code: isUpstream ? 'CODEBUDDY_UPSTREAM_ERROR' : 'STORY_SERVICE_UNAVAILABLE',
    ...(isUpstream ? { upstreamStatus: error.status } : {}),
  }, 'CodeBuddy API request failed')
  return reply.code(status).send({
    error: {
      code: isUpstream ? 'CODEBUDDY_UPSTREAM_ERROR' : 'STORY_SERVICE_UNAVAILABLE',
      message: error instanceof Error ? error.message : 'CodeBuddy API request failed.',
    },
  })
}

function isResumableSession(value: unknown, sessionId: string): boolean {
  return Array.isArray(value) && value.some((entry) =>
    typeof entry === 'object'
    && entry !== null
    && !Array.isArray(entry)
    && 'sessionId' in entry
    && entry.sessionId === sessionId)
}

class StoryWorkspaceUnavailableError extends Error {
  constructor() {
    super('This Story has no associated workspace; initialize and associate its workspace first.')
    this.name = 'StoryWorkspaceUnavailableError'
  }
}

async function relayRead(
  request: FastifyRequest,
  reply: FastifyReply,
  channel: 'DevOps' | 'GitLab',
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : `${channel} request failed.`
    const expiredSession = channel === 'DevOps' && message.includes('session expired')
    request.log.error({ channel, code: expiredSession ? 'SESSION_EXPIRED' : 'UPSTREAM_ERROR' }, 'Read-only upstream request failed')
    return reply.code(expiredSession ? 403 : 502).send({
      error: {
        code: expiredSession ? 'DEVOPS_SESSION_EXPIRED' : 'UPSTREAM_ERROR',
        message: expiredSession ? message : `${channel} request failed. Check the connection status and server logs.`,
      },
    })
  }
}

function invalidParameters(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: { code: 'INVALID_PARAMETERS', message: 'The request parameters are invalid.' },
  })
}

function workspaceInitializationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof WorkspaceInputError) {
    return reply.code(400).send({ error: { code: 'INVALID_WORKSPACE_REQUEST', message: error.message } })
  }
  if (error instanceof WorkspaceConflictError) {
    return reply.code(409).send({ error: { code: 'WORKSPACE_JOB_CONFLICT', message: error.message } })
  }
  const dependency = error instanceof WorkspaceDependencyError
  const code = dependency ? 'WORKSPACE_DEPENDENCY_UNAVAILABLE' : 'WORKSPACE_INITIALIZATION_UNAVAILABLE'
  const message = error instanceof Error ? error.message : 'Workspace initialization failed.'
  request.log.error({ code }, 'Workspace initialization request failed')
  return reply.code(503).send({ error: { code, message } })
}

export async function startServer(): Promise<void> {
  const token = await loadOrCreateToken()
  const storyServiceSupervisor = new StoryServiceSupervisor()
  const workspacesRoot = getWorkspacesRoot()
  const app = buildServer({ token, storyServiceSupervisor, workspacesRoot })
  const port = Number(process.env.PORT ?? 7788)
  const host = process.env.HOST ?? '127.0.0.1'

  await app.listen({ port, host })
  app.log.info({ host, port, dataDirectory: getDataDirectory() }, 'DevTask Console server started')
  void storyServiceSupervisor.recoverPersistedServices(workspacesRoot).catch((error: unknown) => {
    app.log.error({ error }, 'Unable to recover persisted Story services')
  })
}

const serverEntrypoint = fileURLToPath(import.meta.url)
if (process.argv.slice(1).some((argument) => resolve(argument) === serverEntrypoint)) {
  await startServer()
}
