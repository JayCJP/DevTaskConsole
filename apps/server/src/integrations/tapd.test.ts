import { describe, expect, it } from 'vitest'
import { TapdAdapter } from './tapd.js'

const requiredTools = ['get_stories_or_tasks', 'get_related_bugs', 'get_bug', 'get_iterations']
const listing = {
  tools: requiredTools.map((name) => ({
    name,
    inputSchema: { type: 'object' as const, properties: {} },
  })),
}

describe('TAPD MCP connection', () => {
  it('requires the read-only tools used by the aggregator', async () => {
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async () => null,
    })

    await expect(adapter.checkConnection()).resolves.toBe(true)
  })

  it('reports missing read tools and sanitizes process startup errors', async () => {
    const missingToolAdapter = new TapdAdapter({
      listTools: async () => ({
        tools: [{ name: 'get_bug', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: async () => null,
    })
    const failedConnectionAdapter = new TapdAdapter({
      listTools: async () => {
        throw new Error('spawn failed; private-value')
      },
      callTool: async () => null,
    })

    await expect(missingToolAdapter.checkConnection()).rejects.toThrow('get_stories_or_tasks')
    await expect(failedConnectionAdapter.checkConnection()).rejects.toThrow('TAPD MCP connection failed.')
    await expect(failedConnectionAdapter.checkConnection()).rejects.not.toThrow('private-value')
  })

  it('uses the verified bulk query shape and associates owner-matched bugs to each Story', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const responses: Record<string, unknown> = {
      get_stories_or_tasks: {
        data: [
          { Story: { id: '18', name: 'First story', status: 'open', priority_label: 'High', owner: 'Alice', iteration_name: 'Sprint A' } },
          { Story: { id: '81', name: 'Second story', status: 'in_progress', priority_label: 'Middle', owner: 'Bob', iteration_id: 'it2' } },
        ],
        count: 2,
      },
      get_iterations: {
        data: [{ Iteration: { id: 'it2', name: 'Sprint B' } }],
      },
      get_related_bugs: {
        data: [
          { story_id: '18', bug_id: 'b1' },
          { story_id: '18', bug_id: 'b2' },
          { story_id: '81', bug_id: 'b3' },
          { story_id: '81', bug_id: 'b4' },
        ],
      },
      get_bug: {
        data: [
          { Bug: { id: 'b1', title: 'First defect', status: 'new', current_owner: 'Alice;Carol;', created: '2025-12-01', module: 'Login', description: 'Login fails.' } },
          { Bug: { id: 'b2', status: 'reopened', current_owner: 'Bob;' } },
          { Bug: { id: 'b3', title: 'Second defect', status: 'reopened', current_owner: 'Alice;Bob;' } },
          { Bug: { id: 'b4', status: 'new', current_owner: 'Carol;' } },
        ],
        count: 4,
      },
    }
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name, args) => {
        calls.push({ name, args })
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(responses[name]) }] }
      },
    })

    const aggregated = await adapter.aggregate([
      { storyId: 'HARNESS-18', tapdStoryId: '18', title: 'Local first' },
      { storyId: 'HARNESS-81', tapdStoryId: '81', title: 'Local second' },
    ])

    expect(aggregated.requirements).toEqual([
      {
        storyId: 'HARNESS-18',
        tapdStoryId: '18',
        title: 'First story',
        status: 'open',
        priority: 'High',
        owner: 'Alice',
        iterationName: 'Sprint A',
        bugNew: 1,
        bugReopened: 0,
      },
      {
        storyId: 'HARNESS-81',
        tapdStoryId: '81',
        title: 'Second story',
        status: 'in_progress',
        priority: 'Middle',
        owner: 'Bob',
        iterationName: 'Sprint B',
        bugNew: 0,
        bugReopened: 1,
      },
    ])
    expect(aggregated.bugs).toEqual([
      {
        id: 'b1',
        storyId: 'HARNESS-18',
        title: 'First defect',
        status: 'new',
        currentOwner: 'Alice;Carol;',
        created: '2025-12-01',
        module: 'Login',
        description: 'Login fails.',
      },
      { id: 'b3', storyId: 'HARNESS-81', title: 'Second defect', status: 'reopened', currentOwner: 'Alice;Bob;' },
    ])
    expect(calls.map((call) => call.name)).toEqual([
      'get_stories_or_tasks',
      'get_related_bugs',
      'get_iterations',
      'get_bug',
    ])
    expect(calls[0]?.args).toMatchObject({
      workspace_id: 38260062,
      options: { entity_type: 'stories', id: '18,81', limit: 200, fields: 'id,name,status,priority_label,owner,iteration_id,iteration_name' },
    })
    expect(calls[1]?.args).toEqual({ workspace_id: 38260062, options: { story_id: '18,81' } })
    expect(calls[2]?.args).toEqual({
      workspace_id: 38260062,
      options: { id: 'it2', limit: 200, fields: 'id,name' },
    })
    expect(calls[3]?.args).toMatchObject({
      workspace_id: 38260062,
      options: { id: 'b1,b2,b3,b4', status: 'new|reopened', limit: 200 },
    })
  })

  it('does not report a truncated Bug page as an accurate count', async () => {
    const responses: Record<string, unknown> = {
      get_stories_or_tasks: { data: [{ Story: { id: '18', name: 'First story', owner: 'Alice' } }], count: 1 },
      get_related_bugs: { data: [{ story_id: '18', bug_id: 'b1' }, { story_id: '18', bug_id: 'b2' }] },
      get_bug: { data: [{ Bug: { id: 'b1', status: 'new', current_owner: 'Alice;' } }], count: 2 },
    }
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name) => ({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(responses[name]) }],
      }),
    })

    await expect(adapter.enrichRequirements([{ storyId: 'HARNESS-18', tapdStoryId: '18', title: 'Local story' }]))
      .rejects.toThrow('response was truncated')
  })

  it('rejects a truncated related-Bug page instead of silently omitting associations', async () => {
    const responses: Record<string, unknown> = {
      get_stories_or_tasks: { data: [{ Story: { id: '18', name: 'First story', owner: 'Alice' } }], count: 1 },
      get_related_bugs: { data: [{ story_id: '18', bug_id: 'b1' }], count: 2 },
    }
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async (_serverName, name) => ({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(responses[name]) }],
      }),
    })

    await expect(adapter.aggregate([{ storyId: 'HARNESS-18', tapdStoryId: '18', title: 'Local story' }]))
      .rejects.toThrow('get_related_bugs response was truncated')
  })

  it('does not treat a Harness Story id as a TAPD id without an explicit mapping', async () => {
    let toolCalls = 0
    const adapter = new TapdAdapter({
      listTools: async () => listing,
      callTool: async () => {
        toolCalls += 1
        return null
      },
    })

    await expect(adapter.aggregate([{ storyId: 'STORY-20261113-01', title: 'Local story' }]))
      .resolves.toEqual({
        requirements: [{ storyId: 'STORY-20261113-01', title: 'Local story' }],
        bugs: [],
      })
    expect(toolCalls).toBe(0)
  })
})
