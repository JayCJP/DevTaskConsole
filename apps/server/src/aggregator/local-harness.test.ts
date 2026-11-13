import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalHarness } from './local-harness.js'

let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

describe('readLocalHarness', () => {
  it('reads Story metadata from e2e-state.json without changing the source file', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const statePath = join(temporaryRoot, 'workspace', '.codebuddy', 'plans', 'STORY-1', 'e2e-state.json')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify({
      storyId: 'STORY-1',
      title: 'Sample story',
      phase: 2,
      status: 'running',
    }))

    const result = await readLocalHarness(temporaryRoot)

    expect(result.errors).toEqual([])
    expect(result.requirements).toEqual([{
      storyId: 'STORY-1',
      title: 'Sample story',
      status: 'running',
      phase: 2,
      workspacePath: 'workspace',
    }])
    expect(await readFile(statePath, 'utf8')).toContain('"phase":2')
  })

  it('reports malformed state files instead of silently omitting them', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devtask-harness-'))
    const statePath = join(temporaryRoot, 'workspace', '.codebuddy', 'plans', 'STORY-2', 'e2e-state.json')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, '{invalid')

    const result = await readLocalHarness(temporaryRoot)

    expect(result.requirements).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Cannot read')
  })

  it('keeps Harness and TAPD Story identifiers separate', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devtask-harness-mapping-'))
    const storyDirectory = join(temporaryRoot, 'workspace', '.codebuddy', 'plans', 'STORY-20261113-01')
    await mkdir(storyDirectory, { recursive: true })
    await writeFile(join(storyDirectory, 'e2e-state.json'), JSON.stringify({
      storyId: 'STORY-20261113-01',
      title: 'Mapped requirement',
      phase: 1,
      status: 'running',
    }))
    await writeFile(join(storyDirectory, 'story-input.json'), JSON.stringify({
      mode: 'run',
      sources: { storyIdInTapd: '38260062' },
    }))

    const result = await readLocalHarness(temporaryRoot)

    expect(result.requirements).toEqual([expect.objectContaining({
      storyId: 'STORY-20261113-01',
      tapdStoryId: '38260062',
      title: 'Mapped requirement',
    })])
    expect(result.errors).toEqual([])
  })

  it('reads question confirmations and fixbugs triage as read-only local facts', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devtask-harness-artifacts-'))
    const storyDirectory = join(temporaryRoot, 'workspace', '.codebuddy', 'plans', 'STORY-ARTIFACTS')
    await mkdir(storyDirectory, { recursive: true })
    await writeFile(join(storyDirectory, 'e2e-state.json'), JSON.stringify({
      storyId: 'STORY-ARTIFACTS',
      title: 'Artifacts',
      phase: 0,
      status: 'running',
    }))
    await writeFile(join(storyDirectory, 'open-questions.json'), JSON.stringify({
      questions: [
        { id: 'Q-1', question: 'Confirmed?', resolution: 'Yes', confirmation: { answer: 'Yes', confirmedVia: 'accept', confirmedAt: '2026-01-01T00:00:00Z' } },
        { id: 'Q-2', question: 'Informal?', confirmation: { answer: 'Maybe' } },
        { id: 'Q-3', question: 'Pending?', resolution: 'Suggested answer' },
        { id: 'Q-4', question: 'No proposal?', resolved: true },
      ],
    }))
    await writeFile(join(storyDirectory, 'bug-list.json'), JSON.stringify({
      bugs: [{
        bugId: 'BUG-1',
        title: 'Defect title',
        status: 'reopened',
        category: 'frontend',
        commentCount: 2,
        commentDigest: 'A new reproduction was reported.',
        writeback: { commentedAt: '2026-01-02T00:00:00Z', commentKind: 'fixed' },
      }],
    }))
    await writeFile(join(dirname(storyDirectory), '.harness-active'), JSON.stringify({
      active: true,
      storyId: 'STORY-ARTIFACTS',
      title: 'Artifacts',
      mode: 'fixbugs',
      phase: 6,
      activatedAt: '2026-01-03T00:00:00Z',
    }))

    const result = await readLocalHarness(temporaryRoot)

    expect(result.openQuestions.map((question) => question.state)).toEqual([
      'confirmed',
      'confirmed_informal',
      'pending_confirmation',
      'no_proposal',
    ])
    expect(result.harnessBugs).toEqual([{
      storyId: 'STORY-ARTIFACTS',
      bugId: 'BUG-1',
      title: 'Defect title',
      status: 'reopened',
      category: 'frontend',
      commentCount: 2,
      commentDigest: 'A new reproduction was reported.',
      writeback: { commentedAt: '2026-01-02T00:00:00Z', commentKind: 'fixed' },
    }])
    expect(result.harnessActive).toEqual([{
      storyId: 'STORY-ARTIFACTS',
      title: 'Artifacts',
      mode: 'fixbugs',
      phase: 0,
      status: 'running',
      workspacePath: 'workspace',
      activatedAt: '2026-01-03T00:00:00Z',
    }])
    expect(result.errors).toEqual([])
  })
})
