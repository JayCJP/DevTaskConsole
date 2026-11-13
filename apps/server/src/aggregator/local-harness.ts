import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
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
      errors.push(`${relative(root, activePath)} references Harness Story ${storyId} without e2e-state.json.`)
    }
    harnessActive.push({
      storyId,
      title: typeof active.title === 'string' && active.title.trim() ? active.title : requirement?.title ?? storyId,
      ...(active.mode === 'run' || active.mode === 'fixbugs' ? { mode: active.mode } : {}),
      ...(requirement?.phase !== undefined ? { phase: requirement.phase } : {}),
      ...(requirement?.status ? { status: requirement.status } : {}),
      workspacePath: relative(root, directoryFromPlans(plansDirectory)),
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
    if (!plan.isDirectory() || plan.name === 'archive') continue
    const statePath = join(plansDirectory, plan.name, 'e2e-state.json')
    try {
      const state = parseHarnessState(await readFile(statePath, 'utf8'))
      if (!state.storyId || !state.title) {
        errors.push(`${relative(root, statePath)} is missing storyId or title.`)
        continue
      }
      if (requirements.has(state.storyId)) {
        errors.push(`Duplicate Harness storyId ${state.storyId} found at ${relative(root, statePath)}.`)
        continue
      }
      const storyInputPath = join(dirname(statePath), 'story-input.json')
      let tapdStoryId: string | undefined
      try {
        tapdStoryId = parseTapdStoryId(await readFile(storyInputPath, 'utf8'))
      } catch (error) {
        if (!isMissing(error)) {
          errors.push(`Cannot read ${relative(root, storyInputPath)}: ${messageOf(error)}`)
        }
      }
      const storyDirectory = dirname(statePath)
      try {
        const questions = await readOptionalJson(join(storyDirectory, 'open-questions.json'))
        if (questions !== undefined) openQuestions.push(...parseOpenQuestions(state.storyId, questions))
      } catch (error) {
        errors.push(`Cannot read ${relative(root, join(storyDirectory, 'open-questions.json'))}: ${messageOf(error)}`)
      }
      try {
        const bugList = await readOptionalJson(join(storyDirectory, 'bug-list.json'))
        if (bugList !== undefined) harnessBugs.push(...parseHarnessBugs(state.storyId, bugList))
      } catch (error) {
        errors.push(`Cannot read ${relative(root, join(storyDirectory, 'bug-list.json'))}: ${messageOf(error)}`)
      }
      requirements.set(state.storyId, {
        storyId: state.storyId,
        title: state.title,
        status: state.status,
        phase: state.phase,
        workspacePath: relative(root, directoryFromPlans(plansDirectory)),
        ...(tapdStoryId ? { tapdStoryId } : {}),
      })
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`Cannot read ${relative(root, statePath)}: ${messageOf(error)}`)
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error.'
}
