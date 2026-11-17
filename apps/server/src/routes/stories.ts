import { access, mkdir, open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { defaultTapdWorkspaceId } from '@devtask/shared'
import { listWorkspaces } from '../workspaces/registry.js'
import type { AuditLog } from '../services/audit-log.js'
import { invalidParameters } from './support.js'

/**
 * 新建 Story 身份卡请求体。
 *
 * storyId 与 workspaceName 均使用严格正则：只允许字母、数字、点、下划线、连字符，
 * 禁止路径分隔符与 `..`，从源头阻断路径穿越；落盘前再做一次 relative 越界兜底。
 * mode / initialPhase 为兼容旧调用保留，写文件时强制默认 run / 0。
 * sources 由前端从看板「工作区 ↔ TAPD 需求」绑定自动推导后传入，后端不主动查 TAPD。
 */
export const storyCreateRequestSchema = z.object({
  /** Story 业务标识，如 customer-service-onboarding；不是 TAPD 数字 ID */
  storyId: z.string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, 'Story ID 仅允许字母、数字、点、下划线、连字符')
    .refine((value) => value !== '.' && value !== '..', 'Story ID 不能是 . 或 ..'),
  /** Story 标题，一句话描述 */
  title: z.string().trim().min(1).max(200),
  /** 目标工作区名（*.code-workspace 的基名） */
  workspaceName: z.string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, '工作区名含非法字符'),
  /** 兼容旧调用保留；写文件时强制默认 run，不随入参变化 */
  mode: z.enum(['run', 'fixbugs']).optional(),
  /** 兼容旧调用保留；写文件时强制默认 0，不随入参变化 */
  initialPhase: z.number().int().min(0).max(6).optional(),
  /** TAPD 关联来源（可选，由前端从看板绑定推导）；缺失时身份卡不含 TAPD 关联字段 */
  sources: z.object({
    /** 关联 TAPD 需求 ID，写入 sources.storyIdInTapd 供 local-harness 识别 */
    storyIdInTapd: z.string().trim().min(1).max(200).optional(),
    /**
     * TAPD 需求详情页链接。
     * 仅作身份卡记录、不参与解析，因此不强制 URL 格式：
     * 看板行的 tapdUrl schema 为宽松 string，非法值不应阻断整个 Story 创建。
     */
    tapdUrl: z.string().max(2000).optional(),
    /** TAPD 处理人 */
    owner: z.string().trim().max(200).optional(),
  }).optional(),
})

/** Story 创建成功响应体 */
export const storyCreateResultSchema = z.object({
  storyId: z.string(),
  title: z.string(),
  workspaceName: z.string(),
  /** 工作区第一个项目的绝对路径 */
  projectRoot: z.string(),
  /** 落盘的 story-info.json 绝对路径 */
  storyInfoPath: z.string(),
  created: z.literal(true),
})

/** Story 写路由依赖 */
export interface StoryRouteDeps {
  /** 工作区根目录（由 ServerOptions 注入或 getWorkspacesRoot 推导） */
  workspacesRoot: string
  /** 审计流水 */
  audit: AuditLog
}

/**
 * 判断路径是否存在（ENOENT 等一律视为不存在）。
 * @param target 目标路径
 * @returns 存在返回 true，否则 false
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 判断是否为「已存在」文件系统错误。
 * @param error 原始错误
 * @returns code 为 EEXIST 时返回 true
 */
function isEexist(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

/**
 * 注册 Story 写路由。
 *
 * 目前系统对 Story 完全只读，本路由提供空工作区从 0 到 1 的入口：
 * 在工作区第一个项目的 .codebuddy/plans/<storyId>/ 下写最小 story-info.json，
 * 使 readPlans() 识别为 Requirement，实例页即可出现 Story 卡片并启动 CodeBuddy 实例，
 * 后续由用户在对话中执行 /start <storyId> 触发 Harness 流程补全。
 *
 * @param app Fastify 实例
 * @param deps 路由依赖
 * @returns 无返回值
 */
export function registerStoryRoutes(app: FastifyInstance, deps: StoryRouteDeps): void {
  app.post('/api/v1/stories', async (request, reply) => {
    // 1) 参数校验
    const parsed = storyCreateRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidParameters(reply)
    const input = parsed.data

    // 2) 工作区定位：锚点固定为声明顺序中的第一个项目
    const workspaces = await listWorkspaces(deps.workspacesRoot)
    const workspace = workspaces.find((item) => item.name === input.workspaceName)
    if (!workspace) {
      return reply.code(404).send({
        error: { code: 'WORKSPACE_NOT_FOUND', message: `工作区不存在：${input.workspaceName}` },
      })
    }
    const projectRoot = workspace.projects[0]?.path
    if (!projectRoot) {
      return reply.code(404).send({
        error: { code: 'WORKSPACE_NO_PROJECT', message: '工作区没有可锚定的第一个项目。' },
      })
    }

    // 3) 路径越界兜底：story 目录必须仍落在项目根之内
    const storyDir = resolve(projectRoot, '.codebuddy', 'plans', input.storyId)
    const fromRoot = relative(projectRoot, storyDir)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return reply.code(400).send({
        error: { code: 'INVALID_STORY_PATH', message: 'Story 路径越界。' },
      })
    }
    const storyInfoPath = join(storyDir, 'story-info.json')

    // 4) 兼容空工作区：plans 目录可能尚不存在，先递归创建父目录
    try {
      await mkdir(join(projectRoot, '.codebuddy', 'plans'), { recursive: true })
    } catch (error) {
      request.log.error({ err: error }, 'Create plans directory failed')
      return reply.code(503).send({
        error: { code: 'STORY_CREATE_FAILED', message: '无法创建 plans 目录。' },
      })
    }
    // 目录已存在即视为占用，避免覆盖 Harness 已生成的 Story
    if (await exists(storyDir)) {
      return reply.code(409).send({
        error: { code: 'STORY_ALREADY_EXISTS', message: `Story 已存在：${input.storyId}` },
      })
    }

    // 5) 写完整身份卡骨架；wx 独占创建，防并发重复。
    //    version / mode / initialPhase / 时间戳 / repos / workflowRoot / sources 固定项由服务端生成，
    //    sources 中的 TAPD 关联信息来自前端看板绑定推导（缺失时不写）。
    //    字段格式对齐 Harness /start 产出的 story-info.json，便于后续补全与归档。
    const now = new Date().toISOString()
    const identityCard = {
      version: 1,
      storyId: input.storyId,
      title: input.title,
      mode: 'run' as const,
      initialPhase: 0,
      createdAt: now,
      updatedAt: now,
      sources: {
        workspaceId: String(defaultTapdWorkspaceId),
        statusFilter: '待解决,重新打开',
        ...(input.sources?.storyIdInTapd ? { storyIdInTapd: input.sources.storyIdInTapd } : {}),
        ...(input.sources?.tapdUrl ? { tapdUrl: input.sources.tapdUrl } : {}),
        ...(input.sources?.owner ? { owner: input.sources.owner } : {}),
      },
      repos: {
        primary: workspace.projects[0]!.name,
        names: workspace.projects.map((project) => project.name),
      },
      workflowRoot: projectRoot.replaceAll('\\', '/'),
    }
    const content = `${JSON.stringify(identityCard, null, 2)}\n`
    try {
      await mkdir(storyDir)
      const handle = await open(storyInfoPath, 'wx')
      try {
        await handle.writeFile(content, 'utf8')
      } finally {
        await handle.close()
      }

      await deps.audit.record({
        action: 'story.create',
        target: `${input.workspaceName}/${input.storyId}`,
        storyId: input.storyId,
        reversible: false,
        result: 'succeeded',
        after: {
          storyId: input.storyId,
          title: input.title,
          workspaceName: input.workspaceName,
          projectRoot,
        },
      })
      return reply.code(201).send({
        storyId: input.storyId,
        title: input.title,
        workspaceName: input.workspaceName,
        projectRoot,
        storyInfoPath,
        created: true,
      })
    } catch (error) {
      // 并发下另一请求已创建：409，不覆盖
      if (isEexist(error)) {
        return reply.code(409).send({
          error: { code: 'STORY_ALREADY_EXISTS', message: 'Story 已被其他请求创建。' },
        })
      }
      // 审计失败不能掩盖主错误
      await deps.audit.record({
        action: 'story.create',
        target: `${input.workspaceName}/${input.storyId}`,
        storyId: input.storyId,
        reversible: false,
        result: 'failed',
        error: error instanceof Error ? error.message : 'write failed',
      }).catch(() => undefined)
      request.log.error({ err: error }, 'Create story failed')
      return reply.code(503).send({
        error: {
          code: 'STORY_CREATE_FAILED',
          message: error instanceof Error ? error.message : '创建 Story 失败。',
        },
      })
    }
  })
}
