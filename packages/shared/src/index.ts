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
  /**
   * 任务状态。
   * `interrupted` 表示服务重启时确认子进程已不存在；`orphaned` 表示服务重启时
   * 子进程仍在运行但已被本服务脱离，控制台只能观察、不能接管其 stdio。
   */
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted', 'orphaned']),
  stage: z.enum(['worktree', 'workspace_file', 'install', 'graphify', 'verify', 'complete', 'failed']),
  logs: z.array(z.string()),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  /** 启动的 PowerShell 子进程 PID；用于服务重启后判断进程是否仍存活 */
  pid: z.number().int().positive().optional(),
  /** 已重新执行的次数；用于界面区分首次执行与续跑 */
  resumeCount: z.number().int().nonnegative().optional(),
  /** 原始初始化参数；续跑时以同一参数重放幂等脚本 */
  request: workspaceInitializationRequestSchema.optional(),
})

/** 初始化任务续跑请求：必须显式确认，避免误触重复执行 */
export const workspaceInitializationResumeRequestSchema = z.object({
  /** 续跑会重复执行幂等脚本，需确认已知晓 */
  acknowledgeRerun: z.literal(true),
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

/** 定时任务单次执行的状态，取值与 CodeBuddy scheduled-tasks API 一致 */
export const cronExecutionStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed'])

/**
 * 定时任务执行记录（归一后）。
 * 数据可能来自 CodeBuddy API，也可能来自工作区内的 scheduled_task_executions.json，
 * 因此必须带上 source，前端据此区分实时数据与离线兜底数据。
 */
export const cronExecutionSchema = z.object({
  /** 执行记录 ID */
  id: z.string(),
  /** 所属定时任务 ID */
  taskId: z.string(),
  /** 执行状态 */
  status: cronExecutionStatusSchema,
  /** 开始时间（ISO UTC） */
  startedAt: z.string().datetime(),
  /** 结束时间（ISO UTC）；仍在排队或运行时缺省 */
  finishedAt: z.string().datetime().optional(),
  /** CodeBuddy 运行 ID，失败排查时用于定位会话 */
  runId: z.string().optional(),
  /** 失败原因摘要 */
  error: z.string().optional(),
  /** 数据来源：api 为实时查询，file 为本地文件兜底 */
  source: z.enum(['api', 'file']),
})

/** 执行记录分页响应 */
export const cronExecutionPageSchema = z.object({
  executions: z.array(cronExecutionSchema),
  /** 下一页游标；仅 API 来源可能返回 */
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  /** 本次数据来源，与每条记录的 source 保持一致 */
  source: z.enum(['api', 'file']),
  /** 兜底原因说明，例如实例不可达；为 API 数据时缺省 */
  warning: z.string().optional(),
})

/** 定时任务的归属模式：只查询，或查询并修复 */
export const cronModeSchema = z.enum(['query_only', 'query_fix'])

export const cronSchema = z.object({
  id: z.string(),
  storyId: z.string().optional(),
  /** 任务所在目录相对工作区根目录的路径（`<工作区目录>/<项目名>`），用于按工作区归位 */
  workspacePath: z.string().optional(),
  storyTitle: z.string().optional(),
  mode: cronModeSchema.optional(),
  enabled: z.boolean().optional(),
  cron: z.string(),
  nextRun: z.string().datetime().optional(),
  ownerSessionId: z.string().optional(),
  promptFirstLine: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  /** owner session 最近一次校验通过的时间；缺省表示尚未校验 */
  ownerVerifiedAt: z.string().datetime().optional(),
  /** 是否跨 session 持久化 */
  durable: z.boolean().optional(),
  /** 是否循环执行 */
  recurring: z.boolean().optional(),
  /** 有效期天数；null 表示明确永不过期 */
  expiryDays: z.number().int().nullable().optional(),
  /** 最近一次执行记录；仅在读取执行记录后填充 */
  lastExecution: cronExecutionSchema.optional(),
})

/**
 * 创建定时任务请求。
 * storyId 用于解析目标 CodeBuddy 实例端口（按 Story 服务注册表，不做全局回退）。
 */
export const cronCreateRequestSchema = z.object({
  storyId: z.string().min(1).max(200),
  cron: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(40_000),
  recurring: z.boolean().optional(),
  durable: z.boolean().optional(),
  /** 有效期天数；null 表示永不过期 */
  expiryDays: z.number().int().min(1).max(365).nullable().optional(),
  mode: cronModeSchema.optional(),
  ownerSessionId: z.string().trim().min(1).max(200).optional(),
})

/** 更新定时任务请求：所有字段可选，至少需要一项 */
export const cronUpdateRequestSchema = z.object({
  cron: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(40_000).optional(),
  recurring: z.boolean().optional(),
  durable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  expiryDays: z.number().int().min(1).max(365).nullable().optional(),
  mode: cronModeSchema.optional(),
  ownerSessionId: z.string().trim().min(1).max(200).optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  '至少需要提供一个待更新字段。',
)

/** 保存 owner 映射请求：verify 为 true 时先校验 session 归属再落库 */
export const cronOwnerRequestSchema = z.object({
  storyId: z.string().min(1).max(200),
  ownerSessionId: z.string().trim().min(1).max(200),
  mode: cronModeSchema,
  /** 是否强制校验 session 属于该 Story 工作区；默认 true */
  verify: z.boolean().optional(),
})

/** 派发修复轮次请求：把任务派发到独立的 StoryRound Job */
export const cronDispatchRequestSchema = z.object({
  /** 轮次备注，用于在站点登记表里区分多轮派发 */
  label: z.string().trim().min(1).max(200).optional(),
  /**
   * 派发使用的提示词。
   * 缺省使用 `/start fixbugs <storyId>`：这是站点能确认语义的最小指令；
   * 不把定时任务 prompt 的首行当作完整指令，避免拼出半截上下文。
   */
  prompt: z.string().trim().min(1).max(40_000).optional(),
})

/** 归档派发轮次请求 */
export const cronDispatchArchiveRequestSchema = z.object({
  /** 轮次终态 */
  outcome: z.enum(['succeeded', 'failed', 'stopped']),
})

/** 站点登记的派发轮次 */
export const cronDispatchSchema = z.object({
  /** 站点生成的轮次 ID */
  roundId: z.string(),
  taskId: z.string(),
  storyId: z.string(),
  /** 派发时使用的 owner session */
  ownerSessionId: z.string().optional(),
  /** CodeBuddy Job ID */
  jobId: z.string().optional(),
  /** 轮次状态：open 表示未归档，archived 表示终态归档 */
  state: z.enum(['open', 'archived']),
  /** 轮次终态：succeeded / failed / stopped；未归档时缺省 */
  outcome: z.enum(['succeeded', 'failed', 'stopped']).optional(),
  label: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

/** 审计条目的动作类型；只登记站点发起、且可解释的写操作 */
export const auditActionSchema = z.enum([
  'cron.create',
  'cron.update',
  'cron.toggle',
  'cron.delete',
  'cron.renew',
  'cron.owner',
  'cron.dispatch',
  'cron.executions.delete',
  'service.stop',
  'service.remove',
  'workspace.initialize.resume',
])

/**
 * 审计流水条目。
 * before/after 只保存与动作相关的字段快照，不保存 prompt 全文与 session 内容。
 */
export const auditEntrySchema = z.object({
  id: z.string(),
  action: auditActionSchema,
  /** 动作目标标识，例如 taskId 或 storyId */
  target: z.string(),
  /** 关联 Story；无法归属时缺省 */
  storyId: z.string().optional(),
  /** 动作前状态快照 */
  before: z.record(z.string(), z.unknown()).optional(),
  /** 动作后状态快照 */
  after: z.record(z.string(), z.unknown()).optional(),
  /** 是否可撤销；删除类动作不可撤销 */
  reversible: z.boolean(),
  /** 是否已经被撤销 */
  undone: z.boolean(),
  /** 撤销时间 */
  undoneAt: z.string().datetime().optional(),
  /** 操作结果：succeeded 表示动作已生效，failed 表示上游失败未生效 */
  result: z.enum(['succeeded', 'failed']),
  /** 失败原因摘要 */
  error: z.string().optional(),
  createdAt: z.string().datetime(),
})

/** Story 服务运行期监督事件 */
export const serviceEventSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  /** 事件级别：info 正常重启提示，error 最终失败 */
  level: z.enum(['info', 'warning', 'error']),
  /** 事件类型：restart 表示自动重启，failed 表示重试耗尽，recovered 表示恢复健康 */
  kind: z.enum(['restart', 'failed', 'recovered']),
  message: z.string(),
  createdAt: z.string().datetime(),
})

/**
 * 部署事实口径。
 * `unknown` 表示控制台无法从 DevOps 现有字段确认线上部署版本，
 * 页面必须展示「无法确认」，不得由构建成功推断为已部署。
 */
export const deployFactSchema = z.object({
  /** 是否观察到部署事实 */
  fact: z.enum(['unknown', 'observed']),
  /** 可读结论，直接展示给用户 */
  statement: z.string(),
  /** 观察到的环境说明；fact 为 unknown 时缺省 */
  environment: z.string().optional(),
})

/** MR diff 摘要：变更文件数、增删行与热点文件 */
export const mergeRequestDiffSummarySchema = z.object({
  /** 变更文件总数 */
  filesChanged: z.number().int().nonnegative(),
  /** 新增行数；GitLab 未提供时缺省 */
  additions: z.number().int().nonnegative().optional(),
  /** 删除行数；GitLab 未提供时缺省 */
  deletions: z.number().int().nonnegative().optional(),
  /** 变更行数最多的文件名（按变更量降序，最多 5 个） */
  hotFiles: z.array(z.string()),
  /** 是否因为文件过多而截断统计 */
  truncated: z.boolean(),
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
export type WorkspaceInitializationResumeRequest = z.infer<typeof workspaceInitializationResumeRequestSchema>
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
export type CronMode = z.infer<typeof cronModeSchema>
export type CronExecution = z.infer<typeof cronExecutionSchema>
export type CronExecutionStatus = z.infer<typeof cronExecutionStatusSchema>
export type CronExecutionPage = z.infer<typeof cronExecutionPageSchema>
export type CronCreateRequest = z.infer<typeof cronCreateRequestSchema>
export type CronUpdateRequest = z.infer<typeof cronUpdateRequestSchema>
export type CronOwnerRequest = z.infer<typeof cronOwnerRequestSchema>
export type CronDispatchRequest = z.infer<typeof cronDispatchRequestSchema>
export type CronDispatchArchiveRequest = z.infer<typeof cronDispatchArchiveRequestSchema>
export type CronDispatch = z.infer<typeof cronDispatchSchema>
export type AuditAction = z.infer<typeof auditActionSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type ServiceEvent = z.infer<typeof serviceEventSchema>
export type DeployFact = z.infer<typeof deployFactSchema>
export type MergeRequestDiffSummary = z.infer<typeof mergeRequestDiffSummarySchema>

/* ============================================================================
 * cron 规则纯函数
 * 服务端（创建/更新前置校验）与前端（编辑弹层实时校验与预览）共用同一套实现。
 * 这些函数刻意内联在本文件，不拆成独立模块：CodeBuddy 实例以 Node 的原生类型
 * 剥离直接加载本包源码，相对路径再指向 `.js` 会在运行期解析失败。
 * ========================================================================== */

/** 单个 cron 字段的取值上下界 */
interface CronFieldRange {
  /** 字段中文名，用于错误文案 */
  label: string
  /** 最小值（含） */
  min: number
  /** 最大值（含） */
  max: number
}

/** 5 个字段的取值范围，顺序与表达式字段顺序一致 */
const cronFieldRanges: CronFieldRange[] = [
  { label: '分钟', min: 0, max: 59 },
  { label: '小时', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12 },
  { label: '星期', min: 0, max: 7 },
]

/** 控制台要求避开的分钟值：整点与半点 */
export const forbiddenCronMinutes = [0, 30] as const

/** 预设间隔（分钟）与对应表达式，均按「避开 0/30 分」设计 */
export interface CronPreset {
  /** 预设标识，用作列表 key */
  id: string
  /** 中文按钮文案 */
  label: string
  /** 间隔分钟数；60 表示每小时一次 */
  minutes: number
  /** 对应 cron 表达式（5 字段） */
  expression: string
}

/**
 * 控制台提供的 cron 预设。
 * 分钟位刻意选在 5/7/15/25/45，既不落在 0 分与 30 分，也保持相对整齐的间隔。
 */
export const cronPresets: CronPreset[] = [
  { id: 'every-20m', label: '每 20 分钟', minutes: 20, expression: '5,25,45 * * * *' },
  { id: 'every-30m', label: '每 30 分钟', minutes: 30, expression: '15,45 * * * *' },
  { id: 'every-60m', label: '每 60 分钟', minutes: 60, expression: '15 * * * *' },
  { id: 'every-4h', label: '每 4 小时', minutes: 240, expression: '7 */4 * * *' },
  { id: 'every-6h', label: '每 6 小时', minutes: 360, expression: '7 */6 * * *' },
  { id: 'every-8h', label: '每 8 小时', minutes: 480, expression: '7 */8 * * *' },
]

/** cron 校验结果 */
export type CronValidation = { ok: true } | { ok: false; message: string }

/** 解析后的 cron 字段集合 */
export interface ParsedCron {
  /** 分钟位全部取值 */
  minutes: number[]
  /** 小时位全部取值 */
  hours: number[]
  /** 日位全部取值 */
  daysOfMonth: number[]
  /** 月位全部取值 */
  months: number[]
  /** 星期位全部取值（0 与 7 均表示周日） */
  daysOfWeek: number[]
  /** 日位是否为通配（用于标准 cron 的「日/周取或」语义） */
  dayOfMonthWildcard: boolean
  /** 星期位是否为通配 */
  dayOfWeekWildcard: boolean
}

/**
 * 解析单个 cron 字段为取值数组。
 * 支持 `*`、单值、区间 `a-b`、步长 `* /n` 与 `a-b/n`、逗号列表的组合。
 * @param field 字段原文
 * @param range 字段取值上下界与中文名
 * @returns 升序去重后的取值数组；格式非法时返回 undefined
 */
function expandCronField(field: string, range: CronFieldRange): number[] | undefined {
  const text = field.trim()
  if (!text) return undefined
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const segment = part.trim()
    if (!segment) return undefined
    const [base, stepText, ...rest] = segment.split('/')
    if (rest.length > 0 || base === undefined) return undefined
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined
      step = Number(stepText)
      if (step < 1) return undefined
    }
    let start: number
    let end: number
    if (base === '*') {
      start = range.min
      end = range.max
    } else if (/^\d+$/.test(base)) {
      start = Number(base)
      end = start
    } else {
      const match = /^(\d+)-(\d+)$/.exec(base)
      if (!match) return undefined
      start = Number(match[1])
      end = Number(match[2])
    }
    if (start < range.min || end > range.max || start > end) return undefined
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) return undefined
  return [...values].sort((left, right) => left - right)
}

/**
 * 解析 5 字段 cron 表达式。
 * @param expression cron 表达式原文
 * @returns 解析结果；字段数量或取值非法时返回 undefined
 */
export function parseCron(expression: string): ParsedCron | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const expanded = fields.map((field, index) => expandCronField(field, cronFieldRanges[index] as CronFieldRange))
  if (expanded.some((value) => value === undefined)) return undefined
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = expanded as number[][]
  return {
    minutes: minutes as number[],
    hours: hours as number[],
    daysOfMonth: daysOfMonth as number[],
    months: months as number[],
    daysOfWeek: daysOfWeek as number[],
    dayOfMonthWildcard: fields[2]?.trim() === '*',
    dayOfWeekWildcard: fields[4]?.trim() === '*',
  }
}

/**
 * 找出表达式中落在 0 分或 30 分的分钟值。
 * @param expression cron 表达式
 * @returns 违反约定的分钟值数组；表达式非法时返回空数组
 */
export function forbiddenMinutesOf(expression: string): number[] {
  const parsed = parseCron(expression)
  if (!parsed) return []
  return parsed.minutes.filter((minute) => (forbiddenCronMinutes as readonly number[]).includes(minute))
}

/**
 * 校验 cron 表达式是否可用于控制台写操作。
 * 规则：必须是合法 5 字段表达式；分钟位不得包含 0 或 30，避免与整点/半点的其他调度撞车。
 * @param expression 待校验表达式
 * @returns 校验结果；失败时给出可直接展示的中文原因
 */
export function validateCronExpression(expression: string): CronValidation {
  const text = expression.trim()
  if (!text) return { ok: false, message: 'cron 表达式不能为空。' }
  const parsed = parseCron(text)
  if (!parsed) return { ok: false, message: 'cron 表达式必须包含 5 个合法字段：分 时 日 月 周。' }
  const offending = forbiddenMinutesOf(text)
  if (offending.length > 0) {
    return { ok: false, message: `分钟位不能为 0 或 30（当前包含 ${offending.join('、')} 分）。` }
  }
  return { ok: true }
}

/**
 * 判断某个预设是否与给定表达式一致。
 * @param expression 当前表达式
 * @param preset 预设项
 * @returns 完全一致时返回 true
 */
export function matchesPreset(expression: string, preset: CronPreset): boolean {
  return expression.trim().replace(/\s+/g, ' ') === preset.expression
}

/**
 * 判断日期是否命中 cron。
 * @param parsed 已解析的 cron
 * @param date 待判断时间（使用其本地字段）
 * @returns 命中返回 true
 */
function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minutes.includes(date.getMinutes())) return false
  if (!parsed.hours.includes(date.getHours())) return false
  if (!parsed.months.includes(date.getMonth() + 1)) return false
  const dayOfMonthHit = parsed.daysOfMonth.includes(date.getDate())
  const rawDayOfWeek = date.getDay()
  const dayOfWeekHit = parsed.daysOfWeek.includes(rawDayOfWeek)
    || (rawDayOfWeek === 0 && parsed.daysOfWeek.includes(7))
  // 标准 cron 语义：日与周都被限定时取「或」，其中一个为 * 时取「与」
  if (parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard) return true
  if (parsed.dayOfMonthWildcard) return dayOfWeekHit
  if (parsed.dayOfWeekWildcard) return dayOfMonthHit
  return dayOfMonthHit || dayOfWeekHit
}

/** 计算下次运行时间时最多向后扫描的天数，防止不可能命中的表达式死循环 */
const maximumCronScanDays = 366

/**
 * 计算表达式的后续运行时间。
 * @param expression cron 表达式
 * @param from 起点时间，不包含该分钟本身
 * @param count 期望返回的数量
 * @returns 依次递增的时间数组；表达式非法或一年内命中不足时返回能算出的部分
 */
export function nextCronRuns(expression: string, from: Date, count: number): Date[] {
  const parsed = parseCron(expression)
  if (!parsed || count <= 0) return []
  const runs: Date[] = []
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = from.getTime() + maximumCronScanDays * 24 * 60 * 60 * 1000
  while (runs.length < count && cursor.getTime() <= limit) {
    if (cronMatches(parsed, cursor)) runs.push(new Date(cursor.getTime()))
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return runs
}

/**
 * 生成表达式的中文描述，用于任务行与校验区的补充说明。
 * @param expression cron 表达式
 * @returns 中文描述；非法表达式返回「表达式无效」
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression)
  if (!parsed) return '表达式无效'
  const [preset] = cronPresets.filter((item) => matchesPreset(expression, item))
  if (preset) return preset.label
  const minutes = parsed.minutes.join('、')
  if (parsed.hours.length === 24) return `每小时 ${minutes} 分`
  return `每天 ${parsed.hours.join('、')} 时 ${minutes} 分`
}
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
