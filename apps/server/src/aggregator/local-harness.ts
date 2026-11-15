import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HarnessActive, HarnessBug, OpenQuestion, Requirement } from '@devtask/shared'

interface LocalHarnessResult {
  requirements: Requirement[]
  harnessBugs: HarnessBug[]
  openQuestions: OpenQuestion[]
  harnessActive: HarnessActive[]
  errors: string[]
}

interface HarnessState {
  storyId?: string
  title?: string
  status?: string
  phase?: number
}

/**
 * `story-info.json` 的解析结果。
 * 这是 Harness 新版工作流写入的 Story 身份文件：轮次归档只会移动 e2e-state.json，
 * 不会删除它，因此用它识别 Story 才能覆盖已归档的流程。
 */
interface StoryInfo {
  /** Story ID（目录可能被改名，以文件内容为准） */
  storyId: string
  /** Story 标题 */
  title: string
  /** Harness 启动模式 */
  mode?: 'run' | 'fixbugs'
  /** 启动时的阶段；e2e-state.json 缺失时用作当前阶段 */
  initialPhase?: number
  /** 关联的 TAPD 需求 ID */
  tapdStoryId?: string
  /** Harness 的工作目录绝对路径，用于还原 Story 归属的项目 */
  workflowRoot?: string
}

function parseOpenQuestions(storyId: string, value: unknown): OpenQuestion[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    throw new Error('Expected open-questions.json to contain a questions array.')
  }
  return value.questions.map((question, index) => {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string') {
      throw new Error(`Question ${index + 1} is missing its id or text.`)
    }
    const confirmation = isRecord(question.confirmation) ? question.confirmation : undefined
    const answer = typeof confirmation?.answer === 'string' ? confirmation.answer.trim() : ''
    const confirmedVia = confirmation?.confirmedVia
    const confirmedAt = confirmation?.confirmedAt
    const state = answer
      ? confirmedVia === 'verbatim' || confirmedVia === 'accept'
        ? typeof confirmedAt === 'string' && confirmedAt.trim()
          ? 'confirmed'
          : 'confirmed_informal'
        : 'confirmed_informal'
      : typeof question.resolution === 'string' && question.resolution.trim()
        ? 'pending_confirmation'
        : 'no_proposal'
    return {
      storyId,
      id: question.id,
      question: question.question,
      ...(typeof question.resolution === 'string' ? { resolution: question.resolution } : {}),
      state,
    }
  })
}

function parseHarnessBugs(storyId: string, value: unknown): HarnessBug[] {
  if (!isRecord(value) || !Array.isArray(value.bugs)) {
    throw new Error('Expected bug-list.json to contain a bugs array.')
  }
  return value.bugs.map((bug, index) => {
    if (
      !isRecord(bug)
      || typeof bug.bugId !== 'string'
      || typeof bug.title !== 'string'
      || typeof bug.status !== 'string'
    ) {
      throw new Error(`Bug ${index + 1} is missing bugId, title, or TAPD status.`)
    }
    const writeback = isRecord(bug.writeback) ? bug.writeback : undefined
    const commentKind = writeback?.commentKind
    const category = bug.category
    return {
      storyId,
      bugId: bug.bugId,
      title: bug.title,
      status: bug.status,
      ...(category === 'frontend' || category === 'backend' || category === 'collab' ? { category } : {}),
      ...(typeof bug.commentCount === 'number' && Number.isInteger(bug.commentCount) && bug.commentCount >= 0
        ? { commentCount: bug.commentCount }
        : {}),
      ...(typeof bug.commentDigest === 'string' ? { commentDigest: bug.commentDigest } : {}),
      ...(writeback
        && typeof writeback.commentedAt === 'string'
        && (commentKind === 'fixed' || commentKind === 'to_backend' || commentKind === 'to_collab' || commentKind === 'manual')
        ? {
            writeback: {
              commentedAt: writeback.commentedAt,
              ...(typeof writeback.statusChangedAt === 'string' ? { statusChangedAt: writeback.statusChangedAt } : {}),
              commentKind,
            },
          }
        : {}),
    }
  })
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    return JSON.parse(contents) as unknown
  } catch (error) {
    throw new Error(error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON.')
  }
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'archive', 'dist', 'build'])
const maximumDepth = 4

export async function readLocalHarness(workspacesRoot: string): Promise<LocalHarnessResult> {
  const requirements = new Map<string, Requirement>()
  const harnessBugs: HarnessBug[] = []
  const openQuestions: OpenQuestion[] = []
  const harnessActive: HarnessActive[] = []
  const errors: string[] = []
  let rootEntries

  try {
    rootEntries = await readdir(workspacesRoot, { withFileTypes: true })
  } catch (error) {
    return {
      requirements: [],
      harnessBugs: [],
      openQuestions: [],
      harnessActive: [],
      errors: [`Cannot scan workspaces root ${workspacesRoot}: ${messageOf(error)}`],
    }
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue
    await scanDirectory(
      join(workspacesRoot, entry.name),
      workspacesRoot,
      0,
      requirements,
      harnessBugs,
      openQuestions,
      harnessActive,
      errors,
    )
  }

  return { requirements: [...requirements.values()], harnessBugs, openQuestions, harnessActive, errors }
}

async function scanDirectory(
  directory: string,
  root: string,
  depth: number,
  requirements: Map<string, Requirement>,
  harnessBugs: HarnessBug[],
  openQuestions: OpenQuestion[],
  harnessActive: HarnessActive[],
  errors: string[],
): Promise<void> {
  const plansDirectory = join(directory, '.codebuddy', 'plans')
  try {
    await access(plansDirectory)
    await readPlans(plansDirectory, root, requirements, harnessBugs, openQuestions, errors)
    await readHarnessActive(plansDirectory, root, requirements, harnessActive, errors)
  } catch (error) {
    if (!isMissing(error)) {
      errors.push(`Cannot inspect ${relative(root, plansDirectory)}: ${messageOf(error)}`)
    }
  }

  if (depth >= maximumDepth) return
  let children
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    errors.push(`Cannot scan ${relative(root, directory)}: ${messageOf(error)}`)
    return
  }

  for (const child of children) {
    if (child.isDirectory() && !ignoredDirectories.has(child.name)) {
      await scanDirectory(
        join(directory, child.name),
        root,
        depth + 1,
        requirements,
        harnessBugs,
        openQuestions,
        harnessActive,
        errors,
      )
    }
  }
}

async function readHarnessActive(
  plansDirectory: string,
  root: string,
  requirements: Map<string, Requirement>,
  harnessActive: HarnessActive[],
  errors: string[],
): Promise<void> {
  const activePath = join(plansDirectory, '.harness-active')
  try {
    const active = await readOptionalJson(activePath)
    if (active === undefined) return
    if (!isRecord(active) || active.active !== true || typeof active.storyId !== 'string' || !active.storyId.trim()) {
      throw new Error('Expected an active flag with a storyId.')
    }
    if (active.mode !== undefined && active.mode !== 'run' && active.mode !== 'fixbugs') {
      throw new Error('Harness active mode must be run or fixbugs.')
    }
    const storyId = active.storyId.trim()
    const requirement = requirements.get(storyId)
    if (!requirement) {
      errors.push(`${relative(root, activePath)} references Harness Story ${storyId} without story-info.json.`)
    }
    harnessActive.push({
      storyId,
      title: typeof active.title === 'string' && active.title.trim() ? active.title : requirement?.title ?? storyId,
      ...(active.mode === 'run' || active.mode === 'fixbugs' ? { mode: active.mode } : {}),
      ...(requirement?.phase !== undefined ? { phase: requirement.phase } : {}),
      ...(requirement?.status ? { status: requirement.status } : {}),
      // 优先复用需求里已解析的工作区路径，保证与流水线归属一致
      workspacePath: requirement?.workspacePath ?? toWorkspacePath(root, directoryFromPlans(plansDirectory)),
      ...(typeof active.activatedAt === 'string' ? { activatedAt: active.activatedAt } : {}),
    })
  } catch (error) {
    errors.push(`Cannot read ${relative(root, activePath)}: ${messageOf(error)}`)
  }
}

async function readPlans(
  plansDirectory: string,
  root: string,
  requirements: Map<string, Requirement>,
  harnessBugs: HarnessBug[],
  openQuestions: OpenQuestion[],
  errors: string[],
): Promise<void> {
  let plans
  try {
    plans = await readdir(plansDirectory, { withFileTypes: true })
  } catch (error) {
    errors.push(`Cannot list ${relative(root, plansDirectory)}: ${messageOf(error)}`)
    return
  }

  for (const plan of plans) {
    // archive / tmp 是 Harness 的轮次归档目录，不是 Story 本体
    if (!plan.isDirectory() || plan.name === 'archive' || plan.name === 'tmp') continue
    const storyDirectory = join(plansDirectory, plan.name)
    try {
      // story-info.json 是 Story 身份的唯一依据：轮次归档后 e2e-state.json 可能被移走
      const info = parseStoryInfo(await readOptionalJson(join(storyDirectory, 'story-info.json')))
      const statePath = join(storyDirectory, 'e2e-state.json')
      let state: HarnessState | undefined
      try {
        state = await readHarnessState(statePath)
      } catch (error) {
        // 状态文件损坏不影响 Story 识别，只记录原因
        errors.push(`Cannot read ${relative(root, statePath)}: ${messageOf(error)}`)
      }
      if (!info && !state) continue
      const storyId = info?.storyId ?? state?.storyId
      if (!storyId) {
        errors.push(`${relative(root, storyDirectory)} is missing storyId in story-info.json.`)
        continue
      }
      const title = info?.title ?? state?.title
      if (!title) {
        errors.push(`${relative(root, storyDirectory)} is missing title in story-info.json.`)
        continue
      }
      if (requirements.has(storyId)) {
        errors.push(`Duplicate Harness storyId ${storyId} found at ${relative(root, storyDirectory)}.`)
        continue
      }
      // 运行期状态只来自 e2e-state.json；缺失时退回 story-info 的 initialPhase
      const phase = state?.phase ?? info?.initialPhase
      const tapdStoryId = info?.tapdStoryId ?? await readTapdStoryId(storyDirectory, root, errors)
      const workflowDirectory = resolveWorkflowRoot(root, info?.workflowRoot) ?? directoryFromPlans(plansDirectory)

      try {
        const questions = await readOptionalJson(join(storyDirectory, 'open-questions.json'))
        if (questions !== undefined) openQuestions.push(...parseOpenQuestions(storyId, questions))
      } catch (error) {
        errors.push(`Cannot read ${relative(root, join(storyDirectory, 'open-questions.json'))}: ${messageOf(error)}`)
      }
      try {
        const bugList = await readOptionalJson(join(storyDirectory, 'bug-list.json'))
        if (bugList !== undefined) harnessBugs.push(...parseHarnessBugs(storyId, bugList))
      } catch (error) {
        errors.push(`Cannot read ${relative(root, join(storyDirectory, 'bug-list.json'))}: ${messageOf(error)}`)
      }
      requirements.set(storyId, {
        storyId,
        title,
        ...(state?.status ? { status: state.status } : {}),
        ...(phase !== undefined ? { phase } : {}),
        workspacePath: toWorkspacePath(root, workflowDirectory),
        ...(tapdStoryId ? { tapdStoryId } : {}),
      })
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`Cannot read ${relative(root, storyDirectory)}: ${messageOf(error)}`)
      }
    }
  }
}

function parseTapdStoryId(contents: string): string | undefined {
  const parsed: unknown = JSON.parse(contents)
  if (!isRecord(parsed)) throw new Error('Expected story-input.json to contain a JSON object.')
  if (!isRecord(parsed.sources)) return undefined
  const tapdStoryId = parsed.sources.storyIdInTapd
  if (tapdStoryId === undefined || tapdStoryId === null || tapdStoryId === '') return undefined
  if (typeof tapdStoryId !== 'string' || !tapdStoryId.trim()) {
    throw new Error('sources.storyIdInTapd must be a non-empty string.')
  }
  return tapdStoryId.trim()
}

/**
 * 解析 `story-info.json`。
 * 只依赖 storyId/title 两个必需字段，其余字段缺失时忽略，避免旧文件被判为非法。
 * @param value 已解析的 JSON 值
 * @returns Story 身份信息；缺少 storyId 时返回 undefined
 */
function parseStoryInfo(value: unknown): StoryInfo | undefined {
  if (!isRecord(value)) return undefined
  const storyId = typeof value.storyId === 'string' ? value.storyId.trim() : ''
  if (!storyId) return undefined
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : storyId
  const initialPhase = typeof value.initialPhase === 'number'
    && Number.isInteger(value.initialPhase)
    && value.initialPhase >= 0
    && value.initialPhase <= 6
    ? value.initialPhase
    : undefined
  const sources = isRecord(value.sources) ? value.sources : undefined
  const tapdStoryId = typeof sources?.storyIdInTapd === 'string' && sources.storyIdInTapd.trim()
    ? sources.storyIdInTapd.trim()
    : undefined
  const workflowRoot = typeof value.workflowRoot === 'string' && value.workflowRoot.trim()
    ? value.workflowRoot.trim()
    : undefined
  return {
    storyId,
    title,
    ...(value.mode === 'run' || value.mode === 'fixbugs' ? { mode: value.mode } : {}),
    ...(initialPhase !== undefined ? { initialPhase } : {}),
    ...(tapdStoryId ? { tapdStoryId } : {}),
    ...(workflowRoot ? { workflowRoot } : {}),
  }
}

/**
 * 读取并解析 e2e-state.json 的运行期状态。
 * @param path 状态文件绝对路径
 * @returns 运行期状态；文件不存在时返回 undefined
 * @throws Error 文件内容不是合法 JSON
 */
async function readHarnessState(path: string): Promise<HarnessState | undefined> {
  try {
    return parseHarnessState(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * 从 story-input.json 读取 TAPD 需求 ID，作为 story-info.json 之外的兼容来源。
 * @param storyDirectory Story 目录
 * @param root 工作区扫描根目录（用于错误信息里的相对路径）
 * @param errors 错误收集数组
 * @returns TAPD 需求 ID；文件缺失时返回 undefined
 */
async function readTapdStoryId(
  storyDirectory: string,
  root: string,
  errors: string[],
): Promise<string | undefined> {
  const storyInputPath = join(storyDirectory, 'story-input.json')
  try {
    return parseTapdStoryId(await readFile(storyInputPath, 'utf8'))
  } catch (error) {
    if (!isMissing(error)) {
      errors.push(`Cannot read ${relative(root, storyInputPath)}: ${messageOf(error)}`)
    }
    return undefined
  }
}

/**
 * 校验 story-info.json 里的 workflowRoot 是否位于工作区扫描根目录之内。
 * @param root 工作区扫描根目录
 * @param workflowRoot story-info.json 记录的工作目录
 * @returns 绝对路径；未配置或越界时返回 undefined
 */
function resolveWorkflowRoot(root: string, workflowRoot: string | undefined): string | undefined {
  if (!workflowRoot) return undefined
  const candidate = resolve(workflowRoot)
  const fromRoot = relative(resolve(root), candidate)
  // 只把真正的父目录（`..` 或 `..\\x`）判为越界；`..foo` 是合法子目录名
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined
  return candidate
}

function parseHarnessState(contents: string): HarnessState {
  const parsed: unknown = JSON.parse(contents)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Expected a JSON object.')
  }
  const value = parsed as Record<string, unknown>
  return {
    storyId: typeof value.storyId === 'string' ? value.storyId : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
    phase: typeof value.phase === 'number' && Number.isInteger(value.phase) && value.phase >= 0 && value.phase <= 6
      ? value.phase
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function directoryFromPlans(plansDirectory: string): string {
  return dirname(dirname(plansDirectory))
}

/**
 * 把 Story 目录转成相对工作区根的 posix 风格路径。
 * 统一用 `/` 分隔，避免 Windows 下的 `\` 直接出现在 API 与页面里。
 * @param root 工作区扫描根目录
 * @param directory Story 目录绝对路径
 * @returns 相对路径；Story 就在扫描根目录时返回空字符串
 */
function toWorkspacePath(root: string, directory: string): string {
  return relative(root, directory).replaceAll('\\', '/')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error.'
}
