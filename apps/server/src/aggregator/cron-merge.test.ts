import { describe, expect, it } from 'vitest'
import type { Cron } from '@devtask/shared'
import { mergeCronFacts } from './cron-merge.js'

/** 本地文件里的任务事实 */
function localCron(): Cron {
  return {
    id: 'task-1',
    storyId: 'STORY-1',
    storyTitle: 'Requirement',
    workspacePath: 'work-one/repo-a',
    cron: '5,25,45 * * * *',
    enabled: true,
    mode: 'query_only',
    ownerSessionId: 'session-a',
    ownerVerifiedAt: '2026-01-01T00:00:00.000Z',
    promptFirstLine: '检查缺陷',
  }
}

describe('mergeCronFacts', () => {
  it('用实时字段覆盖运行期事实，同时保留本地归属信息', () => {
    const merged = mergeCronFacts(
      [localCron()],
      [{
        storyId: 'STORY-1',
        workspacePath: 'work-one/repo-a',
        tasks: [{ id: 'task-1', cron: '15,45 * * * *', enabled: false, nextRun: '2026-02-01T00:00:00.000Z' }],
      }],
      [],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'task-1',
      storyId: 'STORY-1',
      workspacePath: 'work-one/repo-a',
      cron: '15,45 * * * *',
      enabled: false,
      mode: 'query_only',
      ownerSessionId: 'session-a',
      promptFirstLine: '检查缺陷',
    })
    expect(merged[0]?.nextRun).toBe('2026-02-01T00:00:00.000Z')
  })

  it('实时数据缺失字段时回落到本地值', () => {
    const merged = mergeCronFacts(
      [localCron()],
      [{ storyId: 'STORY-1', tasks: [{ id: 'task-1', cron: '15 * * * *' }] }],
      [],
    )

    expect(merged[0]?.cron).toBe('15 * * * *')
    expect(merged[0]?.enabled).toBe(true)
    expect(merged[0]?.ownerSessionId).toBe('session-a')
  })

  it('本地没有的实时任务追加在末尾，并用服务所属 Story 补齐归属', () => {
    const merged = mergeCronFacts(
      [localCron()],
      [{
        storyId: 'STORY-1',
        workspacePath: 'work-one/repo-a',
        tasks: [{ id: 'task-new', cron: '7 */4 * * *', prompt: '第一行\n第二行' }],
      }],
      [{ taskId: 'task-new', storyId: 'STORY-1', ownerSessionId: 'session-b', mode: 'query_fix' }],
    )

    expect(merged.map((cron) => cron.id)).toEqual(['task-1', 'task-new'])
    expect(merged[1]).toMatchObject({
      storyId: 'STORY-1',
      workspacePath: 'work-one/repo-a',
      mode: 'query_fix',
      ownerSessionId: 'session-b',
      promptFirstLine: '第一行',
    })
  })

  it('没有任何实时来源时原样返回本地列表', () => {
    const local = [localCron()]
    expect(mergeCronFacts(local, [], [])).toBe(local)
  })
})
