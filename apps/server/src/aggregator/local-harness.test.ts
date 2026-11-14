import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalHarness } from './local-harness.js'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * 创建一个 Story 目录并写入指定文件。
 * @param storyDirectory Story 目录绝对路径
 * @param files 文件名到内容的映射（内容会被 JSON 序列化）
 * @returns Promise<void>
 */
async function writeStoryFiles(storyDirectory: string, files: Record<string, unknown>): Promise<void> {
  await mkdir(storyDirectory, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(storyDirectory, name), JSON.stringify(content), 'utf8')
  }
}

describe('local harness story discovery', () => {
  it('identifies a story from story-info.json even when e2e-state.json is gone', async () => {
    root = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const storyDirectory = join(root, 'feature-x', 'repo-a', '.codebuddy', 'plans', 'STORY-1')
    // 归档后只剩 story-info.json：这是本题要修复的场景
    await writeStoryFiles(storyDirectory, {
      'story-info.json': {
        version: 1,
        storyId: 'STORY-1',
        title: '门店群聊支持批量创建代理群',
        mode: 'fixbugs',
        initialPhase: 3,
        sources: { storyIdInTapd: '1138260062001031479' },
        workflowRoot: join(root, 'feature-x', 'repo-a').replaceAll('\\', '/'),
      },
    })

    const result = await readLocalHarness(root)

    expect(result.errors).toEqual([])
    expect(result.requirements).toEqual([expect.objectContaining({
      storyId: 'STORY-1',
      title: '门店群聊支持批量创建代理群',
      phase: 3,
      workspacePath: 'feature-x/repo-a',
      tapdStoryId: '1138260062001031479',
    })])
    // 没有 e2e-state.json 就没有运行期状态
    expect(result.requirements[0]?.status).toBeUndefined()
  })

  it('overlays runtime status and phase from e2e-state.json', async () => {
    root = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const storyDirectory = join(root, 'feature-x', 'repo-a', '.codebuddy', 'plans', 'STORY-2')
    await writeStoryFiles(storyDirectory, {
      'story-info.json': {
        storyId: 'STORY-2',
        title: 'Story Two',
        initialPhase: 1,
      },
      'e2e-state.json': {
        storyId: 'STORY-2',
        title: 'Story Two',
        status: 'running',
        phase: 4,
      },
    })

    const result = await readLocalHarness(root)

    expect(result.errors).toEqual([])
    expect(result.requirements[0]).toMatchObject({ storyId: 'STORY-2', status: 'running', phase: 4 })
  })

  it('still discovers legacy stories that only have e2e-state.json', async () => {
    root = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const storyDirectory = join(root, 'feature-x', 'repo-a', '.codebuddy', 'plans', 'STORY-3')
    await writeStoryFiles(storyDirectory, {
      'e2e-state.json': { storyId: 'STORY-3', title: 'Legacy Story', status: 'blocked', phase: 2 },
    })

    const result = await readLocalHarness(root)

    expect(result.errors).toEqual([])
    expect(result.requirements[0]).toMatchObject({
      storyId: 'STORY-3',
      title: 'Legacy Story',
      status: 'blocked',
      phase: 2,
      workspacePath: 'feature-x/repo-a',
    })
  })

  it('ignores archive and tmp directories inside plans', async () => {
    root = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const plansDirectory = join(root, 'feature-x', 'repo-a', '.codebuddy', 'plans')
    await writeStoryFiles(join(plansDirectory, 'STORY-4'), {
      'story-info.json': { storyId: 'STORY-4', title: 'Story Four' },
    })
    await writeStoryFiles(join(plansDirectory, 'archive', 'round-1'), {
      'story-info.json': { storyId: 'ARCHIVED', title: 'Archived Story' },
    })
    await writeStoryFiles(join(plansDirectory, 'tmp'), {
      'story-info.json': { storyId: 'TMP', title: 'Temp Story' },
    })

    const result = await readLocalHarness(root)

    expect(result.requirements.map((requirement) => requirement.storyId)).toEqual(['STORY-4'])
  })

  it('keeps the plans directory as workspace path when workflowRoot escapes the root', async () => {
    root = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const storyDirectory = join(root, 'feature-x', 'repo-a', '.codebuddy', 'plans', 'STORY-5')
    await writeStoryFiles(storyDirectory, {
      'story-info.json': {
        storyId: 'STORY-5',
        title: 'Story Five',
        workflowRoot: 'D:/elsewhere/repo',
      },
    })

    const result = await readLocalHarness(root)

    expect(result.errors).toEqual([])
    expect(result.requirements[0]?.workspacePath).toBe('feature-x/repo-a')
  })
})
