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

/**
 * DevOps 默认分组名。
 * 约定：git 仓库名与 DevOps 应用名一致，分组默认取该值；
 * 只有名称不一致的项目才需要人工保存差异映射。
 */
export const defaultDevOpsGroup = 'JenkinsFrontweb'

/**
 * 上游系统（GitLab / DevOps）返回的时间字段。
 * 允许带上时区偏移的 ISO 时间（如 `2026-11-11T12:16:22.144+08:00`），
 * 避免上游格式差异导致整个快照校验失败；控制台自身生成的时间仍使用严格 UTC。
 */
export const upstreamDateTimeSchema = z.string().datetime({ offset: true })

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

/** 工作区内的单个项目（git worktree 检出目录） */
export const workspaceProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** 当前检出的分支名；读取失败时缺省 */
  branch: z.string().optional(),
  /** 当前 HEAD 提交号；读取失败时缺省 */
  commitId: z.string().optional(),
  /** 是否为 git worktree 检出（区别于独立克隆） */
  worktree: z.boolean(),
})

/** 工作区列表项：工作区目录 + .code-workspace 文件 + 项目集合 */
export const workspaceSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** <工作区名>.code-workspace 的绝对路径；不存在或缺省 */
  workspaceFile: z.string().optional(),
  /** 工作区目录最后修改时间（ISO 字符串） */
  updatedAt: z.string().optional(),
  /** .code-workspace 中声明但目录已缺失的项目数 */
  missingProjects: z.array(z.string()),
  projects: z.array(workspaceProjectSchema),
})

/** 删除工作区请求体：必须逐字输入确认文案 */
export const workspaceDeleteRequestSchema = z.object({
  confirmText: z.literal('确认删除'),
})

/** 删除工作区结果：逐项目记录 worktree 移除情况 */
export const workspaceDeleteResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  removedWorktrees: z.array(z.string()),
  removedDirectories: z.array(z.string()),
  logs: z.array(z.string()),
  warnings: z.array(z.string()),
})

/**
 * TAPD 需求（数据元）：按处理人从 TAPD 查询得到的只读快照。
 * storyId 为 TAPD 需求 ID，tapdUrl 为可直接打开的详情链接。
 */
export const tapdStorySchema = z.object({
  storyId: z.string(),
  title: z.string(),
  /** TAPD 原始状态码（如 status_9），不做本地猜测式翻译 */
  status: z.string().optional(),
  /** 状态中文名，来自 TAPD 工作流状态映射（如 status_9 → 已发布） */
  statusLabel: z.string().optional(),
  /** TAPD 处理人，可能是用分号分隔的多人 */
  owner: z.string().optional(),
  iterationName: z.string().optional(),
  priority: z.string().optional(),
  createdAt: z.string().optional(),
  tapdUrl: z.string().url(),
})

/**
 * 工作区与 TAPD 需求的绑定关系：一个工作区只绑定一个需求，一个需求只绑定一个工作区。
 * 绑定关系只存本地，不由仓库名或需求标题推断。
 */
export const workspaceBindingSchema = z.object({
  /** TAPD 需求 ID */
  tapdStoryId: z.string().min(1).max(200),
  /** 本地工作区名（取自 *.code-workspace 文件名） */
  workspaceName: z.string().min(1).max(200),
  /** 手动添加时缓存的 TAPD 需求标题 */
  storyTitle: z.string().min(1).max(500).optional(),
  /** 手动添加时缓存的 TAPD 需求链接 */
  tapdUrl: z.string().url().optional(),
  updatedAt: z.string().datetime(),
})

/** 保存绑定的请求体：tapdStoryId 允许直接粘贴 TAPD 链接，由服务端提取 ID */
export const workspaceBindingRequestSchema = z.object({
  tapdStoryId: z.string().trim().min(1).max(500),
  workspaceName: z.string().trim().min(1).max(200),
  storyTitle: z.string().trim().min(1).max(500).optional(),
  tapdUrl: z.string().trim().url().optional(),
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
  /** 事项所属工作区（相对工作区根目录的路径），收件箱按「工作区 → Story」分组时使用 */
  workspacePath: z.string().optional(),
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
  /** 任务所在目录相对工作区根目录的路径（`<工作区目录>/<项目名>`），用于按工作区归位 */
  workspacePath: z.string().optional(),
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
  buildDate: upstreamDateTimeSchema.optional(),
  durationTime: z.number().nonnegative().optional(),
  operator: z.string().optional(),
  fileUrl: z.string().url().optional(),
})

export const branchSchema = z.object({
  app: z.string(),
  group: z.string().optional(),
  name: z.string(),
  commitId: z.string().optional(),
  lastCommitTime: upstreamDateTimeSchema.optional(),
})

export const mergeRequestSchema = z.object({
  projectId: z.number().int().positive(),
  id: z.string(),
  title: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  state: z.string(),
  mergeStatus: z.string().optional(),
  mergedAt: upstreamDateTimeSchema.optional(),
  approvals: z.object({ approved: z.boolean(), approvedBy: z.array(z.string()) }).optional(),
  changesCount: z.number().int().nonnegative().optional(),
  changedFiles: z.array(z.string()).optional(),
  webUrl: z.string().url().optional(),
  /** MR 作者的 GitLab 用户名；用于发布页只显示本人创建的 MR */
  authorUsername: z.string().optional(),
  storyId: z.string().optional(),
})

/**
 * 工作区项目下的 Story 流水线节点。
 * Story 是工作区的下游产物：先有工作区与项目，才会在这里出现流水线。
 */
export const workspacePipelineStorySchema = z.object({
  /** Story 对应的需求快照（工作区相对路径、阶段、状态都在其中） */
  requirement: requirementSchema,
  /** 是否存在 `.harness-active` 活跃流程标记 */
  harnessActive: z.boolean(),
  /** 归属该 Story 的合并请求 */
  mergeRequests: z.array(mergeRequestSchema),
  /** 归属该 Story 的定时任务 */
  crons: z.array(cronSchema),
  /** 归属该 Story 的 CodeBuddy 实例 */
  jobs: z.array(jobSchema),
})

/**
 * 工作区里的第一个项目（`folders[0]`）。
 * 它是该工作区流水线的唯一锚点：Story、合并请求、构建、定时都按它归属。
 */
export const workspacePipelineProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** 当前检出的分支；读取失败时缺省 */
  branch: z.string().optional(),
  /** 当前 HEAD 提交号；读取失败时缺省 */
  commitId: z.string().optional(),
  /** 是否为 git worktree 检出 */
  worktree: z.boolean(),
})

/**
 * 工作区流水线视图：一个工作区对应一条流水线、最多一个 Story。
 * 识别规则只有一条：Story 只从第一个项目目录的 `.codebuddy/plans` 读取，
 * 一个工作区下即使存在多份 plans 也只展示一份。
 */
export const workspacePipelineSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** `<工作区名>.code-workspace` 的绝对路径；不存在或缺省 */
  workspaceFile: z.string().optional(),
  /** 工作区目录最后修改时间（ISO 字符串） */
  updatedAt: z.string().optional(),
  /** `.code-workspace` 中声明但目录已缺失的项目名 */
  missingProjects: z.array(z.string()),
  /** 第一个项目；`.code-workspace` 未声明任何项目时缺省 */
  primaryProject: workspacePipelineProjectSchema.optional(),
  /** 该工作区展示的唯一 Story；第一个项目没有 plans 时缺省 */
  story: workspacePipelineStorySchema.optional(),
  /** 第一个项目下检测到的 Story 份数，大于 1 表示有多余 plans，仅展示其中一份 */
  storyCandidates: z.number().int().nonnegative(),
  /** 合并请求：第一个项目当前分支 + 该 Story */
  mergeRequests: z.array(mergeRequestSchema),
  /** 构建记录：按第一个项目名（默认等于 DevOps 应用名）匹配 */
  builds: z.array(buildSchema),
  /** 远程分支：按第一个项目名匹配 */
  branches: z.array(branchSchema),
  /** 定时任务：位于第一个项目目录下的全部任务 */
  crons: z.array(cronSchema),
})

/**
 * 当前查看者的外部系统身份。
 * 发布页据此只显示本人的记录；任一字段缺失表示无法识别，对应列表不做人员过滤。
 */
export const viewerIdentitySchema = z.object({
  /** GitLab 当前访问令牌对应的用户名（匹配 MR 作者） */
  gitlabUsername: z.string().optional(),
  /** DevOps 当前登录账号（匹配构建记录的操作人） */
  devopsOperator: z.string().optional(),
})

export const snapshotSchema = z.object({
  snapshotAt: z.string().datetime(),
  /** 当前查看者身份；识别失败时缺省 */
  viewer: viewerIdentitySchema.optional(),
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
  /** 以工作区为根组织的流水线视图；工作区扫描失败时缺省 */
  workspacePipelines: z.array(workspacePipelineSchema).optional(),
})

/** 看板行：TAPD 需求 + 其绑定的本地工作区 */
export const boardStorySchema = z.object({
  storyId: z.string(),
  title: z.string(),
  status: z.string().optional(),
  /** 状态中文名，直接来自 TAPD 工作流状态映射 */
  statusLabel: z.string().optional(),
  owner: z.string().optional(),
  iterationName: z.string().optional(),
  tapdUrl: z.string(),
  /** 该行是否出现在当前处理人的 TAPD 查询结果中；false 表示来自本地手动绑定 */
  inTapdList: z.boolean(),
  /** 绑定记录中的工作区名（工作区目录可能已被删除） */
  workspaceName: z.string().optional(),
  /** 解析成功的工作区目录绝对路径 */
  workspacePath: z.string().optional(),
  /** 解析成功的工作区配置文件绝对路径 */
  workspaceFile: z.string().optional(),
  boundAt: z.string().datetime().optional(),
})

/** 看板接口响应：TAPD 需求列表 + 可绑定的工作区清单 */
export const boardResponseSchema = z.object({
  /** 当前查询的 TAPD 处理人 */
  owner: z.string(),
  fetchedAt: z.string().datetime().nullable(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** 本次是否包含“已发布”需求（默认排除） */
  includeReleased: z.boolean(),
  /** 被默认筛选隐藏的已发布需求数量 */
  hiddenReleased: z.number().int().nonnegative(),
  stories: z.array(boardStorySchema),
  workspaces: z.array(workspaceSummarySchema),
})

/**
 * 视为“已发布”的 TAPD 状态中文名，默认在看板中排除。
 * 状态码与中文名的对应关系以 TAPD 工作流状态映射为准，不做本地猜测。
 */
export const releasedStoryStatusLabels = ['已发布']

export const loginRequestSchema = z.object({
  token: z.string().min(1),
})

export type ChannelState = z.infer<typeof channelStateSchema>
export type RepositoryCandidate = z.infer<typeof repositoryCandidateSchema>
export type ApplicationMapping = z.infer<typeof applicationMappingSchema>
export type WorkspaceInitializationRequest = z.infer<typeof workspaceInitializationRequestSchema>
export type WorkspaceInitializationJob = z.infer<typeof workspaceInitializationJobSchema>
export type WorkspacePreview = z.infer<typeof workspacePreviewSchema>
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type WorkspaceDeleteResult = z.infer<typeof workspaceDeleteResultSchema>
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
export type ViewerIdentity = z.infer<typeof viewerIdentitySchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type WorkspacePipelineStory = z.infer<typeof workspacePipelineStorySchema>
export type WorkspacePipelineProject = z.infer<typeof workspacePipelineProjectSchema>
export type WorkspacePipeline = z.infer<typeof workspacePipelineSchema>
export type TapdStory = z.infer<typeof tapdStorySchema>
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>
export type WorkspaceBindingRequest = z.infer<typeof workspaceBindingRequestSchema>
export type BoardStory = z.infer<typeof boardStorySchema>
export type BoardResponse = z.infer<typeof boardResponseSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
