import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPOSITORY_CANDIDATES_CACHE_VERSION, type RepositoryCandidate } from '@devtask/shared'
import {
  candidateCacheKey,
  createCachedCandidateProvider,
  RepositoryCandidatesCache,
} from './repository-candidates-cache.js'

let directory: string
const candidates: RepositoryCandidate[] = [
  { name: 'project-a', path: 'D:\\repos\\project-a' },
  { name: 'project-b', path: 'D:\\repos\\project-b' },
]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'devtask-candidate-cache-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('candidateCacheKey', () => {
  it('normalizes trailing separators and whitespace', () => {
    expect(candidateCacheKey('  D:\\repos\\  ')).toBe('D:\\repos')
    expect(candidateCacheKey('D:/repos')).toBe('D:/repos')
  })
})

describe('RepositoryCandidatesCache', () => {
  it('returns undefined for a missing cache file', () => {
    expect(new RepositoryCandidatesCache(directory).read('D:\\repos')).toBeUndefined()
  })

  it('round-trips entries and keeps different keys isolated', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    await cache.write('D:\\repos', candidates)
    await cache.write('D:\\other', [])

    expect(cache.read('D:\\repos')).toEqual(candidates)
    expect(cache.read('D:\\other')).toEqual([])
    expect(cache.read('D:\\missing')).toBeUndefined()
  })

  it('discards corrupt JSON', async () => {
    await writeFile(join(directory, 'repository-candidates-cache.json'), '{ not json', 'utf8')
    expect(new RepositoryCandidatesCache(directory).read('D:\\repos')).toBeUndefined()
  })

  it('discards entries with a mismatched version', async () => {
    await writeFile(
      join(directory, 'repository-candidates-cache.json'),
      JSON.stringify({ version: REPOSITORY_CANDIDATES_CACHE_VERSION + 1, entries: {} }),
      'utf8',
    )
    expect(new RepositoryCandidatesCache(directory).read('D:\\repos')).toBeUndefined()
  })

  it('writes atomically without leaving temp files', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    await cache.write('D:\\repos', candidates)

    const files = await readdir(directory)
    expect(files).toEqual(['repository-candidates-cache.json'])
  })
})

describe('createCachedCandidateProvider', () => {
  it('serves cache hits without scanning', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    await cache.write('D:\\repos', candidates)
    const scan = vi.fn(async () => [])

    const provider = createCachedCandidateProvider({ cache, scan })
    await expect(provider('D:\\repos')).resolves.toEqual(candidates)
    expect(scan).not.toHaveBeenCalled()
  })

  it('scans and writes on a cache miss', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    const scan = vi.fn(async () => candidates)

    const provider = createCachedCandidateProvider({ cache, scan })
    await expect(provider('D:\\repos')).resolves.toEqual(candidates)
    expect(scan).toHaveBeenCalledOnce()
    expect(cache.read('D:\\repos')).toEqual(candidates)
  })

  it('bypasses the cache on force', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    await cache.write('D:\\repos', candidates)
    const scan = vi.fn(async () => [candidates[0]!])

    const provider = createCachedCandidateProvider({ cache, scan })
    await expect(provider('D:\\repos', true)).resolves.toEqual([candidates[0]])
    expect(scan).toHaveBeenCalledOnce()
    expect(cache.read('D:\\repos')).toEqual([candidates[0]])
  })

  it('does not cache empty results so transient misses are not persisted', async () => {
    const cache = new RepositoryCandidatesCache(directory)
    const scan = vi.fn(async () => [])

    const provider = createCachedCandidateProvider({ cache, scan })
    await expect(provider('D:\\repos')).resolves.toEqual([])
    expect(cache.read('D:\\repos')).toBeUndefined()
    // 下一次仍会回源，而不是命中空缓存
    await provider('D:\\repos')
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('degrades gracefully when cache write fails', async () => {
    const scan = vi.fn(async () => candidates)
    const logError = vi.fn()
    const brokenCache = {
      read: () => undefined,
      write: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }

    const provider = createCachedCandidateProvider({ cache: brokenCache, scan, logError })
    await expect(provider('D:\\repos')).resolves.toEqual(candidates)
    expect(logError).toHaveBeenCalledOnce()
  })
})
