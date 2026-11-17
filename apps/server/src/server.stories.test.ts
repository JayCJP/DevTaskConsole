import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.js'
import { AuditLog } from './services/audit-log.js'

const accessToken = 's'.repeat(64)
const headers = { 'x-devtask-token': accessToken }
const workspaceName = 'feature-x'

let workspacesRoot: string
let dataDirectory: string
let projectRoot: string
let auditLog: AuditLog
let server: ReturnType<typeof buildServer>

/**
 * 造一个由 *.code-workspace 声明的工作区，第一个项目为 repo-a。
 * @returns Promise<void>
 */
async function createWorkspaceFixture(): Promise<void> {
  await mkdir(join(workspacesRoot, workspaceName, 'repo-a', '.git'), { recursive: true })
  await writeFile(
    join(workspacesRoot, workspaceName, 'repo-a', '.git', 'HEAD'),
    'ref: refs/heads/feat/x\n',
    'utf8',
  )
  await writeFile(
    join(workspacesRoot, workspaceName, `${workspaceName}.code-workspace`),
    JSON.stringify({ folders: [{ path: 'repo-a' }], settings: {} }),
    'utf8',
  )
  projectRoot = join(workspacesRoot, workspaceName, 'repo-a')
}

beforeEach(async () => {
  workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-stories-root-'))
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-stories-data-'))
  await createWorkspaceFixture()
  auditLog = new AuditLog(dataDirectory)
  server = buildServer({
    token: accessToken,
    logger: false,
    workspacesRoot,
    auditLog,
  })
})

afterEach(async () => {
  await server.close()
  await rm(workspacesRoot, { recursive: true, force: true })
  await rm(dataDirectory, { recursive: true, force: true })
})

/**
 * 发起新建 Story 请求。
 * @param body 请求体
 * @returns Fastify 注入响应
 */
function createStory(body: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/stories',
    headers,
    payload: body,
  })
}

describe('story creation API', () => {
  it('成功创建完整身份卡并落盘 story-info.json', async () => {
    const response = await createStory({ storyId: 'manual-e2e-smoke', title: '手工验证 Story', workspaceName })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      storyId: 'manual-e2e-smoke',
      title: '手工验证 Story',
      workspaceName,
      created: true,
    })
    const written = await readFile(join(projectRoot, '.codebuddy', 'plans', 'manual-e2e-smoke', 'story-info.json'), 'utf8')
    const data = JSON.parse(written)
    expect(data).toMatchObject({
      version: 1,
      storyId: 'manual-e2e-smoke',
      title: '手工验证 Story',
      mode: 'run',
      initialPhase: 0,
      sources: { workspaceId: '38260062', statusFilter: '待解决,重新打开' },
      repos: { primary: 'repo-a', names: ['repo-a'] },
      workflowRoot: projectRoot.replaceAll('\\', '/'),
    })
    expect(typeof data.createdAt).toBe('string')
    expect(data.createdAt).toBe(data.updatedAt)
    // 无 TAPD 绑定时不写 storyIdInTapd
    expect(data.sources).not.toHaveProperty('storyIdInTapd')
    // 稳定格式：2 空格缩进 + 末尾换行
    expect(written.endsWith('\n')).toBe(true)
  })

  it('即使传入 mode / initialPhase 也强制默认 run / 0', async () => {
    const response = await createStory({
      storyId: 'with-options',
      title: '带可选字段',
      workspaceName,
      mode: 'fixbugs',
      initialPhase: 2,
    })

    expect(response.statusCode).toBe(201)
    const written = await readFile(join(projectRoot, '.codebuddy', 'plans', 'with-options', 'story-info.json'), 'utf8')
    const data = JSON.parse(written)
    expect(data.mode).toBe('run')
    expect(data.initialPhase).toBe(0)
  })

  it('带 sources 时落盘完整 TAPD 关联信息', async () => {
    const response = await createStory({
      storyId: 'with-tapd',
      title: '带 TAPD 关联',
      workspaceName,
      sources: {
        storyIdInTapd: '1138260062001031567',
        tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1138260062001031567',
        owner: '蔡杰鹏',
      },
    })

    expect(response.statusCode).toBe(201)
    const written = await readFile(join(projectRoot, '.codebuddy', 'plans', 'with-tapd', 'story-info.json'), 'utf8')
    const data = JSON.parse(written)
    expect(data.sources).toMatchObject({
      storyIdInTapd: '1138260062001031567',
      tapdUrl: 'https://www.tapd.cn/38260062/prong/stories/view/1138260062001031567',
      owner: '蔡杰鹏',
      workspaceId: '38260062',
      statusFilter: '待解决,重新打开',
    })
  })

  it('重复创建同一 storyId 返回 409 且不覆盖原文件', async () => {
    const first = await createStory({ storyId: 'dup-story', title: '原始标题', workspaceName })
    expect(first.statusCode).toBe(201)
    const second = await createStory({ storyId: 'dup-story', title: '覆盖尝试', workspaceName })

    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('STORY_ALREADY_EXISTS')
    const written = await readFile(join(projectRoot, '.codebuddy', 'plans', 'dup-story', 'story-info.json'), 'utf8')
    expect(JSON.parse(written).title).toBe('原始标题')
  })

  it.each(['../evil', 'a/b', '..', '.', '中文', ''])('非法 storyId %j 返回 400', async (storyId) => {
    const response = await createStory({ storyId, title: '标题', workspaceName })
    expect(response.statusCode).toBe(400)
  })

  it('工作区不存在返回 404', async () => {
    const response = await createStory({ storyId: 's1', title: '标题', workspaceName: 'nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('成功创建写入审计，重复请求不再产生成功审计', async () => {
    const ok = await createStory({ storyId: 'audit-ok', title: '审计成功', workspaceName })
    expect(ok.statusCode).toBe(201)
    const bad = await createStory({ storyId: 'audit-ok', title: '重复', workspaceName })
    expect(bad.statusCode).toBe(409)

    const entries = await auditLog.list()
    const storyEntries = entries.filter((entry) => entry.action === 'story.create')
    expect(storyEntries).toHaveLength(1)
    expect(storyEntries[0]).toMatchObject({ result: 'succeeded', target: `${workspaceName}/audit-ok` })
    expect(storyEntries[0]?.storyId).toBe('audit-ok')
  })
})
