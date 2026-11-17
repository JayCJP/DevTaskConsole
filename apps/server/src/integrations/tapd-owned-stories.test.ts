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
        if (name === 'get_related_bugs') {
          return {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify({ data: [], info: 'success' }) }],
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
    expect(storyQueries[0]?.args.options).toMatchObject({ fields: expect.stringContaining('parent_id') })
    expect(calls.map((call) => call.name)).toEqual([
      'get_stories_or_tasks',
      'get_workitem_types',
      'get_workflows_status_map',
      'get_related_bugs',
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
    // 无 parent_id 时每个需求自身作为父行（自有链接、无折叠子需求）
    expect(result.parentStories).toHaveLength(2)
    expect(result.parentStories?.[0]).toMatchObject({
      storyId: '1138260062001031810',
      isParentRow: true,
      children: [],
      parentTapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1138260062001031810',
    })
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

  it('groups child stories under their parent and aggregates related bugs for the board owner', async () => {
    const childId = '1138260062001031733'
    const siblingId = '1138260062001031735'
    const parentId = '1138260062001031699'
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name, args) => {
        calls.push({ name, args })
        if (name === 'get_workitem_types') {
          return textResponse({ data: [{ WorkitemType: { id: '1', entity_type: 'story' } }] })
        }
        if (name === 'get_workflows_status_map') {
          return textResponse({ status: 1, data: { status_7: '开发中', status_9: '已发布' } })
        }
        if (name === 'get_related_bugs') {
          // 缺陷只挂在父需求上；子需求无直接关联
          return textResponse({ data: [
            { story_id: parentId, bug_id: 'bug-1' },
            { story_id: parentId, bug_id: 'bug-2' },
          ] })
        }
        if (name === 'get_bug') {
          return textResponse({
            status: 1,
            data: [
              { id: 'bug-1', status: 'new', current_owner: '蔡杰鹏;', title: '缺陷一' },
              // 非本人缺陷，不应计入
              { id: 'bug-2', status: 'reopened', current_owner: '张三;', title: '缺陷二' },
            ],
            count: 2,
          })
        }
        const options = args.options as { id?: string; owner?: string }
        if (options.id === parentId) {
          // 批量取父需求
          return textResponse({
            url_template: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
            data: [{ Story: {
              id: parentId,
              name: '红包领取上限支持按照时间段',
              owner: 'hupengfei;杜鹏;',
              status: 'status_7',
              parent_id: '0',
              children_id: `||${childId}|${siblingId}`,
            } }],
            count: 1,
          })
        }
        // 按 owner 查询：两个子需求
        return textResponse({
          url_template: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
          data: [
            { Story: { id: childId, name: '子需求 A', owner: '蔡杰鹏;', parent_id: parentId, children_id: '|' } },
            { Story: { id: siblingId, name: '子需求 B', owner: '蔡杰鹏;', parent_id: parentId, children_id: '|' } },
          ],
          count: 2,
        })
      },
    })

    const result = await adapter.listOwnedStories('蔡杰鹏')

    // 两个子需求合并为一个父行，父行链接指向父需求
    expect(result.parentStories).toHaveLength(1)
    const parent = result.parentStories?.[0]
    expect(parent).toMatchObject({
      storyId: parentId,
      title: '红包领取上限支持按照时间段',
      isParentRow: true,
      parentTapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${parentId}`,
      bugNew: 1,
      bugReopened: 0,
    })
    expect(parent?.children.map((child) => child.storyId)).toEqual([childId, siblingId])
    // get_related_bugs 使用「父 + 全部子」拼接；bug 归属仍按看板 owner 本人判定
    const relatedCall = calls.find((call) => call.name === 'get_related_bugs')
    expect((relatedCall?.args.options as { story_id: string }).story_id).toBe(
      `${parentId},${childId},${siblingId}`)
  })

  it('keeps parent grouping when bug aggregation fails', async () => {
    const childId = 'c1'
    const parentId = 'p1'
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name, args) => {
        if (name === 'get_workitem_types') {
          return textResponse({ data: [{ WorkitemType: { id: '1', entity_type: 'story' } }] })
        }
        if (name === 'get_workflows_status_map') {
          return textResponse({ status: 1, data: { status_7: '开发中' } })
        }
        if (name === 'get_related_bugs') throw new Error('TAPD bug service unavailable')
        const options = args.options as { id?: string }
        if (options.id === parentId) {
          return textResponse({
            url_template: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
            data: [{ Story: { id: parentId, name: '父需求', status: 'status_7' } }],
            count: 1,
          })
        }
        return textResponse({
          url_template: 'https://www.tapd.cn/38260062/prong/stories/view/{id}',
          data: [{ Story: { id: childId, name: '子需求', owner: '蔡杰鹏;', parent_id: parentId } }],
          count: 1,
        })
      },
    })

    const result = await adapter.listOwnedStories('蔡杰鹏')

    // bug 查询失败不应破坏父子分组：仍是一个父行 + 折叠子需求，只是无 bug 计数
    expect(result.parentStories).toHaveLength(1)
    expect(result.parentStories?.[0]).toMatchObject({
      storyId: parentId,
      isParentRow: true,
    })
    expect(result.parentStories?.[0]?.children.map((child) => child.storyId)).toEqual([childId])
    expect(result.parentStories?.[0]?.bugNew).toBeUndefined()
  })

  it('resolves a child story id to its parent, falling back to itself on failure', async () => {
    let fail = false
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name, args) => {
        if (fail) throw new Error('TAPD unavailable')
        const options = args.options as { id?: string }
        return textResponse({
          data: options.id === 'child'
            ? [{ Story: { id: 'child', parent_id: 'parent' } }]
            : [{ Story: { id: options.id, parent_id: '0' } }],
          count: 1,
        })
      },
    })

    expect(await adapter.resolveParentStoryId('child')).toBe('parent')
    expect(await adapter.resolveParentStoryId('parent')).toBe('parent')
    fail = true
    expect(await adapter.resolveParentStoryId('child')).toBe('child')
  })
})

/** 把任意 JSON 值包装为 MCP text 响应 */
function textResponse(value: unknown): {
  isError: boolean
  content: Array<{ type: 'text'; text: string }>
  toolResult?: unknown
} {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }
}
