import { describe, expect, it } from 'vitest'
import { TapdAdapter } from './tapd.js'

const requiredTools = ['get_stories_or_tasks', 'get_related_bugs', 'get_bug', 'get_iterations']
const listing = {
  tools: requiredTools.map((name) => ({
    name,
    inputSchema: { type: 'object' as const, properties: {} },
  })),
}

describe('TAPD owned stories', () => {
  it('queries stories by owner and builds links from the returned url template', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name, args) => {
        calls.push({ name, args })
        // 状态中文名通过 TAPD 工作流接口读取，这里模拟真实响应
        if (name === 'get_workitem_types') {
          return {
            isError: false,
            content: [{
              type: 'text',
              text: JSON.stringify({
                data: [{ WorkitemType: { id: '1138260062001000132', entity_type: 'story', name: '需求' } }],
              }),
            }],
          }
        }
        if (name === 'get_workflows_status_map') {
          return {
            isError: false,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 1, data: { status_4: '方案中', status_9: '已发布' } }),
            }],
          }
        }
        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              url_template: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
              data: [
                {
                  Story: {
                    id: '1138260062001031810',
                    name: '客服需求 A',
                    status: 'status_9',
                    owner: '蔡杰鹏;',
                    iteration_name: '11 月迭代',
                    priority_label: 'High',
                    created: '2026-11-11 11:27:04',
                  },
                },
                { Story: { id: '1138260062001031780', name: '客服需求 B', owner: '蔡杰鹏;' } },
              ],
              count: { status: 1, data: { count: 2 }, info: 'success' },
            }),
          }],
        }
      },
    })

    const result = await adapter.listOwnedStories(' 蔡杰鹏 ')

    const storyQueries = calls.filter((call) => call.name === 'get_stories_or_tasks')
    expect(storyQueries).toHaveLength(1)
    expect(storyQueries[0]?.args).toMatchObject({
      workspace_id: 38260062,
      options: { entity_type: 'stories', owner: '蔡杰鹏', limit: 200 },
    })
    expect(calls.map((call) => call.name)).toEqual([
      'get_stories_or_tasks',
      'get_workitem_types',
      'get_workflows_status_map',
    ])
    expect(result.urlTemplate).toBe('https://www.tapd.cn/38260062/prong/stories/view/{id}')
    expect(result.stories).toEqual([
      {
        storyId: '1138260062001031810',
        title: '客服需求 A',
        status: 'status_9',
        statusLabel: '已发布',
        owner: '蔡杰鹏;',
        iterationName: '11 月迭代',
        priority: 'High',
        createdAt: '2026-11-11 11:27:04',
        tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1138260062001031810',
      },
      {
        storyId: '1138260062001031780',
        title: '客服需求 B',
        owner: '蔡杰鹏;',
        tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1138260062001031780',
      },
    ])
  })

  it('falls back to the default link template when TAPD omits url_template', async () => {
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async () => ({
        isError: false,
        content: [{
          type: 'text',
          text: JSON.stringify({ data: [{ Story: { id: '18', name: 'Story 18' } }], count: 1 }),
        }],
      }),
    })

    const result = await adapter.listOwnedStories('蔡杰鹏')

    expect(result.stories[0]?.tapdUrl).toBe('https://www.tapd.cn/38260062/prong/stories/view/18')
  })

  it('rejects an empty owner and truncated responses', async () => {
    const truncating = new TapdAdapter({
      listTools: async () => listing,
      callTool: async () => ({
        isError: false,
        content: [{
          type: 'text',
          text: JSON.stringify({ data: [{ Story: { id: '18', name: 'Story 18' } }], count: 5 }),
        }],
      }),
    })

    await expect(truncating.listOwnedStories('  ')).rejects.toThrow('处理人')
    await expect(truncating.listOwnedStories('蔡杰鹏')).rejects.toThrow('truncated')
  })
})
