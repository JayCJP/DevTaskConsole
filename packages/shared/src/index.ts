import { z } from 'zod'

export const channelStateSchema = z.object({
  fetchedAt: z.string().datetime().nullable(),
  ok: z.boolean(),
  stale: z.boolean(),
  error: z.string().optional(),
})

export const repositoryCandidateSchema = z.object({
  name: z.string(),
  path: z.string(),
})

export const applicationMappingSchema = z.object({
  repoName: z.string().min(1).max(200),
  gitlabProjectId: z.number().int().positive().optional(),
  devopsApp: z.string().min(1).max(200).optional(),
  devopsGroup: z.string().min(1).max(200).optional(),
}).refine(
  (mapping) => mapping.gitlabProjectId !== undefined || mapping.devopsApp !== undefined,
  'At least one integration mapping is required.',
).refine(
  (mapping) => (mapping.devopsApp === undefined) === (mapping.devopsGroup === undefined),
  'DevOps app and group must be configured together.',
)

export const workspaceInitializationRequestSchema = z.object({
  workspaceName: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).refine(
    (name) => name !== '.' && name !== '..' && !name.endsWith('.'),
    'Workspace name cannot be a relative path segment or end with a period.',
  ),
  repositoryNames: z.array(z.string().min(1).max(200).regex(/^[^,\r\n]+$/)).min(1).max(100).refine(
    (names) => new Set(names).size === names.length,
    'Repository names must be unique.',
  ),
  branch: z.string().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  baseBranch: z.string().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  skipInstall: z.boolean().default(false),
  skipGraphify: z.boolean().default(false),
})

export const workspaceInitializationJobSchema = z.object({
  id: z.string().uuid(),
  workspaceName: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  stage: z.enum(['worktree', 'workspace_file', 'install', 'graphify', 'verify', 'complete', 'failed']),
  logs: z.array(z.string()),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
})

export const workspacePreviewSchema = z.object({
  logs: z.array(z.string()),
  exitCode: z.number().int(),
})

export const requirementSchema = z.object({
  storyId: z.string(),
  tapdStoryId: z.string().optional(),
  title: z.string(),
  status: z.string().optional(),
  priority: z.string().optional(),
  owner: z.string().optional(),
  iterationName: z.string().optional(),
  phase: z.number().int().min(0).max(6).optional(),
  bugNew: z.number().int().nonnegative().optional(),
  bugReopened: z.number().int().nonnegative().optional(),
  workspacePath: z.string().optional(),
  activeJobs: z.number().int().nonnegative().optional(),
  cronEnabled: z.boolean().optional(),
})

export const bugSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  title: z.string().optional(),
  status: z.string(),
  currentOwner: z.string(),
  created: z.string().optional(),
  module: z.string().optional(),
  description: z.string().optional(),
})

export const harnessBugSchema = z.object({
  storyId: z.string(),
  bugId: z.string(),
  title: z.string(),
  status: z.string(),
  category: z.enum(['frontend', 'backend', 'collab']).optional(),
  commentCount: z.number().int().nonnegative().optional(),
  commentDigest: z.string().optional(),
  writeback: z.object({
    commentedAt: z.string(),
    statusChangedAt: z.string().optional(),
    commentKind: z.enum(['fixed', 'to_backend', 'to_collab', 'manual']),
  }).optional(),
})

export const openQuestionSchema = z.object({
  storyId: z.string(),
  id: z.string(),
  question: z.string(),
  resolution: z.string().optional(),
  state: z.enum(['pending_confirmation', 'no_proposal', 'confirmed', 'confirmed_informal']),
})

export const harnessActiveSchema = z.object({
  storyId: z.string(),
  title: z.string(),
  mode: z.enum(['run', 'fixbugs']).optional(),
  phase: z.number().int().min(0).max(6).optional(),
  status: z.string().optional(),
  workspacePath: z.string(),
  activatedAt: z.string().optional(),
})

export const inboxItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['blocked_job', 'open_question', 'reopened_bug', 'merge_request', 'failed_build', 'credential_warning']),
  title: z.string(),
  reason: z.string(),
  requirementId: z.string().optional(),
  priority: z.enum(['high', 'normal']),
  updatedAt: z.string().datetime().optional(),
  target: z.string().optional(),
})

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  state: z.string(),
  status: z.string(),
  storyId: z.string().optional(),
  sessionId: z.string().optional(),
})

export const jobCreateRequestSchema = z.object({
  prompt: z.string().min(1).max(40_000),
  name: z.string().min(1).max(200),
  agent: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  effort: z.string().max(40).optional(),
  permissionMode: z.string().max(80).optional(),
  bash: z.boolean().optional(),
  bgIsolation: z.boolean().optional(),
})

export const jobReplyRequestSchema = z.object({
  text: z.string().min(1).max(40_000),
  bash: z.literal(false).default(false),
})

export const jobRenameRequestSchema = z.object({
  name: z.string().min(1).max(200),
})

export const resumableSessionSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().optional(),
})

export const cronSchema = z.object({
  id: z.string(),
  storyId: z.string().optional(),
  storyTitle: z.string().optional(),
  mode: z.enum(['query_only', 'query_fix']).optional(),
  enabled: z.boolean().optional(),
  cron: z.string(),
  nextRun: z.string().datetime().optional(),
  ownerSessionId: z.string().optional(),
  promptFirstLine: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
})

export const buildSchema = z.object({
  id: z.string(),
  app: z.string(),
  group: z.string().optional(),
  number: z.string().optional(),
  branch: z.string().optional(),
  commitId: z.string().optional(),
  succeed: z.boolean().nullable(),
  buildDate: z.string().datetime().optional(),
  durationTime: z.number().nonnegative().optional(),
  operator: z.string().optional(),
  fileUrl: z.string().url().optional(),
})

export const branchSchema = z.object({
  app: z.string(),
  group: z.string().optional(),
  name: z.string(),
  commitId: z.string().optional(),
  lastCommitTime: z.string().datetime().optional(),
})

export const mergeRequestSchema = z.object({
  projectId: z.number().int().positive(),
  id: z.string(),
  title: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  state: z.string(),
  mergeStatus: z.string().optional(),
  mergedAt: z.string().datetime().optional(),
  approvals: z.object({ approved: z.boolean(), approvedBy: z.array(z.string()) }).optional(),
  changesCount: z.number().int().nonnegative().optional(),
  changedFiles: z.array(z.string()).optional(),
  webUrl: z.string().url().optional(),
  storyId: z.string().optional(),
})

export const snapshotSchema = z.object({
  snapshotAt: z.string().datetime(),
  channels: z.record(z.string(), channelStateSchema),
  requirements: z.array(requirementSchema),
  bugs: z.array(bugSchema),
  harnessBugs: z.array(harnessBugSchema),
  openQuestions: z.array(openQuestionSchema),
  harnessActive: z.array(harnessActiveSchema),
  inbox: z.array(inboxItemSchema),
  jobs: z.array(jobSchema),
  crons: z.array(cronSchema),
  builds: z.array(buildSchema),
  branches: z.array(branchSchema).optional(),
  mergeRequests: z.array(mergeRequestSchema),
})

export const loginRequestSchema = z.object({
  token: z.string().min(1),
})

export type ChannelState = z.infer<typeof channelStateSchema>
export type RepositoryCandidate = z.infer<typeof repositoryCandidateSchema>
export type ApplicationMapping = z.infer<typeof applicationMappingSchema>
export type WorkspaceInitializationRequest = z.infer<typeof workspaceInitializationRequestSchema>
export type WorkspaceInitializationJob = z.infer<typeof workspaceInitializationJobSchema>
export type WorkspacePreview = z.infer<typeof workspacePreviewSchema>
export type Requirement = z.infer<typeof requirementSchema>
export type Bug = z.infer<typeof bugSchema>
export type HarnessBug = z.infer<typeof harnessBugSchema>
export type OpenQuestion = z.infer<typeof openQuestionSchema>
export type HarnessActive = z.infer<typeof harnessActiveSchema>
export type InboxItem = z.infer<typeof inboxItemSchema>
export type Job = z.infer<typeof jobSchema>
export type Cron = z.infer<typeof cronSchema>
export type Build = z.infer<typeof buildSchema>
export type Branch = z.infer<typeof branchSchema>
export type MergeRequest = z.infer<typeof mergeRequestSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
