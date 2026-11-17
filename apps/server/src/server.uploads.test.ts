import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Snapshot } from '@devtask/shared'
import { buildServer } from './server.js'
import type { StoryServiceSupervisor } from './services/story-service-supervisor.js'

const accessToken = 'z'.repeat(64)
let server: ReturnType<typeof buildServer> | undefined
let workspacesRoot: string | undefined
let projectRoot: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  workspacesRoot = undefined
  projectRoot = undefined
})

/**
 * 构造只含一个 Story 的快照，workspacePath 指向临时工作区下的项目根。
 * @returns 快照对象
 */
function snapshot(): Snapshot {
  return {
    snapshotAt: '2026-01-01T00:00:00.000Z',
    channels: {},
    requirements: [{ storyId: 'STORY-1', title: 'Requirement', workspacePath: 'work-one/repo-a' }],
    bugs: [],
    harnessBugs: [],
    openQuestions: [],
    harnessActive: [],
    inbox: [],
    jobs: [],
    crons: [],
  }
}

/**
 * 构造上传测试用的 app：ensureRunning 返回项目根作为 cwd。
 * @returns app 实例
 */
async function buildUploadApp(): Promise<ReturnType<typeof buildServer>> {
  workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-uploads-'))
  projectRoot = join(workspacesRoot, 'work-one', 'repo-a')
  const supervisor = {
    ensureRunning: vi.fn(async (storyId: string, cwd: string) => ({
      storyId,
      port: 61000,
      cwd,
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  } as unknown as StoryServiceSupervisor
  const app = buildServer({
    token: accessToken,
    logger: false,
    workspacesRoot,
    snapshotProvider: async () => snapshot(),
    storyServiceSupervisor: supervisor,
  })
  server = app
  return app
}

/** 带令牌的请求头 */
const headers = { 'x-devtask-token': accessToken }

describe('story file uploads', () => {
  it('把文件写入 Story 项目的 .docs/<storyId>/ 目录并返回相对路径', async () => {
    const app = await buildUploadApp()
    const form = new FormData()
    // 1x1 透明 PNG
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    )
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'photo.png')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/uploads',
      headers,
      payload: form,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as {
      name: string
      originalName: string
      mimeType: string
      relativePath: string
      absolutePath: string
    }
    expect(body.name).toMatch(/\.png$/)
    expect(body.originalName).toBe('photo.png')
    expect(body.mimeType).toBe('image/png')
    expect(body.relativePath).toMatch(/^\.docs\/STORY-1\/[0-9a-f-]+\.png$/)
    expect(body.absolutePath).toContain(join('.docs', 'STORY-1'))

    const files = await readdir(join(projectRoot!, '.docs', 'STORY-1'))
    expect(files).toHaveLength(1)
    const saved = await readFile(join(projectRoot!, '.docs', 'STORY-1', files[0]!))
    expect(saved.equals(bytes)).toBe(true)
  })

  it('支持非图片类型的文件上传', async () => {
    const app = await buildUploadApp()
    const form = new FormData()
    form.append('file', new Blob(['hello doc'], { type: 'text/plain' }), 'notes.txt')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/uploads',
      headers,
      payload: form,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as { name: string; relativePath: string; mimeType: string }
    expect(body.name).toMatch(/\.txt$/)
    expect(body.mimeType).toBe('text/plain')
    expect(body.relativePath).toMatch(/^\.docs\/STORY-1\/[0-9a-f-]+\.txt$/)
    const files = await readdir(join(projectRoot!, '.docs', 'STORY-1'))
    expect(files).toHaveLength(1)
    expect((await readFile(join(projectRoot!, '.docs', 'STORY-1', files[0]!))).toString()).toBe('hello doc')
  })

  it('清洗危险的原始文件名：落盘只用 UUID 与安全扩展名', async () => {
    const app = await buildUploadApp()
    const form = new FormData()
    // 原始名含路径分隔符与中文，绝不能进入落盘路径
    form.append('file', new Blob(['x'], { type: 'application/octet-stream' }), '../../evil name.tar.gz')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/uploads',
      headers,
      payload: form,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json() as { name: string; originalName: string; absolutePath: string }
    // 扩展名取最后一段 .gz；落盘名是 UUID，不含入侵字符
    expect(body.name).toMatch(/^[0-9a-f-]+\.gz$/)
    expect(body.name).not.toContain('..')
    // Fastify multipart 会剥掉原始名里的路径分隔符；无论是否剥离，落盘都不含危险字符
    expect(body.absolutePath).not.toContain('evil name')
    expect(body.absolutePath).not.toContain('..')
    const files = await readdir(join(projectRoot!, '.docs', 'STORY-1'))
    expect(files).toEqual([body.name])
  })

  it('拒绝没有安全扩展名的文件名', async () => {
    const app = await buildUploadApp()
    const form = new FormData()
    // .tar.gz 里的 .tar 含风险字符时会取到最后一段 .gz，这里用无扩展名触发拒绝
    form.append('file', new Blob(['x'], { type: 'application/octet-stream' }), 'noextension')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/stories/STORY-1/uploads',
      headers,
      payload: form,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_UPLOAD_FILENAME' } })
  })

  it('拒绝含路径穿越字符的 storyId', async () => {
    const app = await buildUploadApp()
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'x.png')

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/stories/${encodeURIComponent('../evil')}/uploads`,
      headers,
      payload: form,
    })

    expect(response.statusCode).toBe(400)
  })
})
