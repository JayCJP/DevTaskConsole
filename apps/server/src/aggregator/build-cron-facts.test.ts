import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CronFacts } from './snapshot.js'

let workspacesRoot: string
let dataDirectory: string
let buildCronFacts: (root?: string) => Promise<CronFacts>
const previousEnv = {
  dataDirectory: process.env.DEVTASK_DATA_DIR,
  mcpConfig: process.env.DEVTASK_MCP_CONFIG,
}

beforeAll(async () => {
  workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-cron-facts-'))
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-cron-facts-data-'))
  // 故意指向不存在的 MCP 配置：定时任务事实不应需要任何上游连接
  process.env.DEVTASK_MCP_CONFIG = join(workspacesRoot, 'missing-mcp.json')
  process.env.DEVTASK_DATA_DIR = dataDirectory

  const projectPath = join(workspacesRoot, 'feature-x', 'repo-a')
  await mkdir(join(projectPath, '.git'), { recursive: true })
  await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/feat/feature-x\n', 'utf8')
  const plansPath = join(projectPath, '.codebuddy', 'plans', 'STORY-1')
  await mkdir(plansPath, { recursive: true })
  await writeFile(join(plansPath, 'e2e-state.json'), JSON.stringify({
    storyId: 'STORY-1',
    title: '本地需求标题',
    phase: 1,
    status: 'running',
  }), 'utf8')
  await writeFile(join(projectPath, '.codebuddy', 'scheduled_tasks.json'), JSON.stringify({
    tasks: [{ id: 'task-1', cron: '13 * * * *', prompt: 'Check the TAPD bugs.' }],
  }), 'utf8')
  await writeFile(
    join(workspacesRoot, 'feature-x', 'feature-x.code-workspace'),
    JSON.stringify({ folders: [{ path: 'repo-a' }], settings: {} }),
    'utf8',
  )

  // 数据目录由环境变量决定，因此设置好临时目录后再加载模块
  const module = await import('./snapshot.js')
  buildCronFacts = module.buildCronFacts
})

afterAll(async () => {
  await rm(workspacesRoot, { recursive: true, force: true })
  await rm(dataDirectory, { recursive: true, force: true })
  restoreEnv('DEVTASK_DATA_DIR', previousEnv.dataDirectory)
  restoreEnv('DEVTASK_MCP_CONFIG', previousEnv.mcpConfig)
})

/**
 * 还原环境变量，保留「原本不存在」与「空字符串」的区别。
 * @param key 环境变量名
 * @param value 记录的原值
 * @returns 无返回值
 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('cron facts', () => {
  it('builds scheduled task facts from local files without any upstream client', async () => {
    const facts = await buildCronFacts(workspacesRoot)

    expect(facts.crons).toEqual([
      expect.objectContaining({
        id: 'task-1',
        cron: '13 * * * *',
        storyId: 'STORY-1',
        storyTitle: '本地需求标题',
        workspacePath: 'feature-x/repo-a',
      }),
    ])
    expect(facts.requirements).toEqual([
      expect.objectContaining({ storyId: 'STORY-1', title: '本地需求标题' }),
    ])
    expect(facts.workspaces.map((workspace) => workspace.name)).toEqual(['feature-x'])
    expect(Number.isNaN(Date.parse(facts.channel.fetchedAt ?? ''))).toBe(false)
  })
})
