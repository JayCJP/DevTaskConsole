import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardCache } from '../aggregator/board-cache.js'
import { makeBoardResponse } from '../aggregator/board-cache.fixture.js'
import { SnapshotCache } from '../aggregator/snapshot-cache.js'
import { makeCacheEntry } from '../aggregator/snapshot-cache.fixture.js'

let cacheDirectory: string

beforeEach(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), 'devtask-cache-dir-'))
})

afterEach(async () => {
  await rm(cacheDirectory, { recursive: true, force: true })
})

/**
 * 验证所有缓存实例都把文件写到传入的自定义目录，
 * 这是“整个缓存数据目录可配”在 server 启动时统一传 cacheDirectory 的基础。
 */
describe('cache classes honor the configured directory', () => {
  it('BoardCache writes into the configured directory', async () => {
    const cache = new BoardCache(cacheDirectory)
    await cache.write('蔡杰鹏|0', makeBoardResponse())

    expect(existsSync(join(cacheDirectory, 'board-cache.json'))).toBe(true)
  })

  it('SnapshotCache writes into the configured directory', async () => {
    const cache = new SnapshotCache(cacheDirectory)
    await cache.write(makeCacheEntry())

    expect(existsSync(join(cacheDirectory, 'snapshot-cache.json'))).toBe(true)
  })
})
