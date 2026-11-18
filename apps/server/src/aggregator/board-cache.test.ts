import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOARD_CACHE_VERSION } from '@devtask/shared'
import { BoardCache } from './board-cache.js'
import { FIXTURE_AT, FIXTURE_KEY, makeBoardResponse } from './board-cache.fixture.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'devtask-board-cache-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('BoardCache', () => {
  it('returns undefined when the cache file does not exist', () => {
    const cache = new BoardCache(directory)
    expect(cache.read(FIXTURE_KEY)).toBeUndefined()
  })

  it('round-trips a valid entry and matches by key', async () => {
    const cache = new BoardCache(directory)
    const response = makeBoardResponse()
    await cache.write(FIXTURE_KEY, response)

    expect(cache.read(FIXTURE_KEY)).toEqual(response)
    // 不同 key 视为 miss
    expect(cache.read('其他人|0')).toBeUndefined()
  })

  it('hits an old entry regardless of age (no TTL)', async () => {
    const cache = new BoardCache(directory)
    // 写入一个很久以前抓取的响应；无 TTL 语义下仍应命中
    await cache.write(FIXTURE_KEY, makeBoardResponse({ at: '2020-01-01T00:00:00.000Z' }))

    expect(cache.read(FIXTURE_KEY)).toEqual(makeBoardResponse({ at: '2020-01-01T00:00:00.000Z' }))
  })

  it('discards corrupt JSON', async () => {
    await writeFile(join(directory, 'board-cache.json'), '{ not json', 'utf8')
    const cache = new BoardCache(directory)
    expect(cache.read(FIXTURE_KEY)).toBeUndefined()
  })

  it('discards entries with a mismatched version', async () => {
    const cache = new BoardCache(directory)
    const cacheFile = {
      version: 999,
      entries: { [FIXTURE_KEY]: { fetchedAt: FIXTURE_AT, response: makeBoardResponse() } },
    }
    await writeFile(join(directory, 'board-cache.json'), JSON.stringify(cacheFile), 'utf8')
    expect(cache.read(FIXTURE_KEY)).toBeUndefined()
  })

  it('discards entries that fail schema validation', async () => {
    const cache = new BoardCache(directory)
    const cacheFile = {
      version: BOARD_CACHE_VERSION,
      entries: {
        [FIXTURE_KEY]: {
          fetchedAt: FIXTURE_AT,
          response: { ...makeBoardResponse(), hiddenReleased: -1 },
        },
      },
    }
    await writeFile(join(directory, 'board-cache.json'), JSON.stringify(cacheFile), 'utf8')
    expect(cache.read(FIXTURE_KEY)).toBeUndefined()
  })

  it('keeps other keys when writing one key', async () => {
    const cache = new BoardCache(directory)
    const first = makeBoardResponse({ storyId: '1001' })
    const second = makeBoardResponse({ storyId: '1002' })
    await cache.write(FIXTURE_KEY, first)
    await cache.write('蔡杰鹏|1', second)

    expect(cache.read(FIXTURE_KEY)).toEqual(first)
    expect(cache.read('蔡杰鹏|1')).toEqual(second)
  })

  it('writes atomically: no temp files remain after a successful write', async () => {
    const cache = new BoardCache(directory)
    await cache.write(FIXTURE_KEY, makeBoardResponse())
    const files = await readdir(directory)
    expect(files).toEqual(['board-cache.json'])
  })
})
