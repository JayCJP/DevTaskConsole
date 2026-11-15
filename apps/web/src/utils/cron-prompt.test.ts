import { describe, expect, it } from 'vitest'
import { buildCronPrompt, type CronPromptContext } from './cron-prompt'

const context: CronPromptContext = {
  storyTitle: '【微赞】客服在线状态优化',
  tapdStoryId: '1138260062001031479',
  workspaceId: '38260062',
  owner: '蔡杰鹏',
  storyId: 'STORY-20261029-01',
  plansDir: 'D:/workspaces/feature-a/repo/.codebuddy/plans',
}

describe('cron-prompt', () => {
  it('生成只查模板并替换全部 Story 与 TAPD 信息', () => {
    const prompt = buildCronPrompt('query_only', context)
    expect(prompt).toContain('【定时任务：轮询需求「【微赞】客服在线状态优化」的关联 Bug（只查不修）】')
    expect(prompt).toContain('workspace_id=38260062')
    expect(prompt).toContain('current_owner: "蔡杰鹏"')
    expect(prompt).toContain('status: "new|reopened"')
    expect(prompt).not.toContain('{{')
    expect(prompt).not.toContain('/start fixbugs')
  })

  it('自动修复模板复用当前 Story 和 plans 绝对路径', () => {
    const prompt = buildCronPrompt('query_fix', context)
    expect(prompt).toContain('工作流 Story ID：STORY-20261029-01')
    expect(prompt).toContain('D:/workspaces/feature-a/repo/.codebuddy/plans/.harness-active')
    expect(prompt).toContain('按 /start skill 入口 A 建流')
    expect(prompt).not.toContain('{{')
  })
})
