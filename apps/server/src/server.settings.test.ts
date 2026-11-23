import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from './server.js'
import { makeBoardResponse } from './aggregator/board-cache.fixture.js'
import { SettingsStore } from './settings/settings-store.js'
import type { CandidateCacheStore } from './workspaces/repository-candidates-cache.js'

const token = 'c'.repeat(64)
let dataDirectory: string
let repositoriesRoot: string
let settingsStore: SettingsStore
let candidateCache: CandidateCacheStore

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-settings-api-'))
  repositoriesRoot = await mkdtemp(join(tmpdir(), 'devtask-source-root-'))
  await mkdir(join(repositoriesRoot, 'project-a', '.git'), { recursive: true })
  settingsStore = new SettingsStore(dataDirectory)
  candidateCache = {
    read: vi.fn(() => undefined),
    write: vi.fn(async () => {}),
  }
})

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true })
  await rm(repositoriesRoot, { recursive: true, force: true })
})

/**
 * 构造携带临时配置存储的 server。
 * @returns server 实例
 */
function createServer() {
  return buildServer({ token, logger: false, settingsStore, candidateCache })
}

describe('console settings API', () => {
  it('returns empty settings initially', async () => {
    const server = createServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: { 'x-devtask-token': token },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({})
    } finally {
      await server.close()
    }
  })

  it('round-trips settings and persists them across server restarts', async () => {
    const payload = {
      devtaskSourceRoot: repositoriesRoot,
      tapdOwner: '测试处理人',
      cacheDirectory: join(dataDirectory, 'custom-cache'),
    }
    const first = createServer()
    try {
      const put = await first.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { 'x-devtask-token': token },
        payload,
      })
      expect(put.statusCode).toBe(200)
      expect(put.json()).toEqual(payload)
    } finally {
      await first.close()
    }

    // 用同一数据目录重建 server，验证配置从磁盘恢复
    const second = createServer()
    try {
      const get = await second.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: { 'x-devtask-token': token },
      })
      expect(get.json()).toEqual(payload)
    } finally {
      await second.close()
    }
  })

  it('rejects invalid settings payloads with 400', async () => {
    const server = createServer()
    try {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { 'x-devtask-token': token },
        payload: { tapdOwner: 123 },
      })
      expect(response.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('uses the configured source root for repository candidates', async () => {
    await settingsStore.update({ devtaskSourceRoot: repositoriesRoot })
    const server = createServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/workspaces/candidates',
        headers: { 'x-devtask-token': token },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual([
        { name: 'project-a', path: join(repositoriesRoot, 'project-a') },
      ])
      expect(candidateCache.write).toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('bypasses the candidate cache when refresh=1', async () => {
    await settingsStore.update({ devtaskSourceRoot: repositoriesRoot })
    const server = createServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/workspaces/candidates?refresh=1',
        headers: { 'x-devtask-token': token },
      })
      expect(response.statusCode).toBe(200)
      expect(candidateCache.read).not.toHaveBeenCalled()
      expect(response.json()).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('uses the configured TAPD owner for board requests without an explicit owner', async () => {
    await settingsStore.update({ tapdOwner: '配置处理人' })
    const boardProvider = vi.fn(async () => ({
      ...makeBoardResponse(),
      owner: '配置处理人',
    }))
    const server = buildServer({ token, logger: false, settingsStore, boardProvider })
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/board/stories',
        headers: { 'x-devtask-token': token },
      })
      expect(response.statusCode).toBe(200)
      expect(boardProvider).toHaveBeenCalledWith('配置处理人', false, false)
    } finally {
      await server.close()
    }
  })

  it('writes cache files into the configured cache directory after restart', async () => {
    const customCacheDir = join(dataDirectory, 'custom-cache')
    // 先保存配置（含自定义缓存目录与源根目录）
    const writer = createServer()
    try {
      const put = await writer.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { 'x-devtask-token': token },
        payload: { devtaskSourceRoot: repositoriesRoot, cacheDirectory: customCacheDir },
      })
      expect(put.statusCode).toBe(200)
    } finally {
      await writer.close()
    }

    // 不注入 candidateCache：让 server 用真实缓存实例，验证目录取自配置
    const restarted = buildServer({ token, logger: false, settingsStore })
    try {
      const response = await restarted.inject({
        method: 'GET',
        url: '/api/v1/workspaces/candidates',
        headers: { 'x-devtask-token': token },
      })
      expect(response.statusCode).toBe(200)
      expect(existsSync(join(customCacheDir, 'repository-candidates-cache.json'))).toBe(true)
    } finally {
      await restarted.close()
    }
  })
})
