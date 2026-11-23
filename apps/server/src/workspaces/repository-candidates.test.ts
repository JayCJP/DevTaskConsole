import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSourceRoot,
  listRepositoryCandidates,
  resolveSourceRoot,
} from './repository-candidates.js'

let sourceRoot: string | undefined

afterEach(async () => {
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true })
  sourceRoot = undefined
})

describe('repository candidates', () => {
  it('lists only immediate directories containing a git metadata entry', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'devtask-repositories-'))
    await mkdir(join(sourceRoot, 'beta', '.git'), { recursive: true })
    await mkdir(join(sourceRoot, 'alpha', '.git'), { recursive: true })
    await mkdir(join(sourceRoot, 'not-a-repository'), { recursive: true })

    await expect(listRepositoryCandidates(sourceRoot)).resolves.toEqual([
      { name: 'alpha', path: join(sourceRoot, 'alpha') },
      { name: 'beta', path: join(sourceRoot, 'beta') },
    ])
  })

  it('surfaces an unavailable source root instead of returning an empty list', async () => {
    sourceRoot = join(tmpdir(), `missing-devtask-repositories-${Date.now()}`)

    await expect(listRepositoryCandidates(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('resolve source root', () => {
  it('prefers the persisted configuration over the environment', async () => {
    vi.stubEnv('DEVTASK_SOURCE_ROOT', 'D:\\from-env')
    try {
      await expect(resolveSourceRoot({ devtaskSourceRoot: 'D:\\from-config' })).resolves.toBe(
        'D:\\from-config',
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back to the environment when the configuration is blank', async () => {
    vi.stubEnv('DEVTASK_SOURCE_ROOT', 'D:\\from-env')
    try {
      await expect(resolveSourceRoot({ devtaskSourceRoot: '   ' })).resolves.toBe('D:\\from-env')
      await expect(resolveSourceRoot()).resolves.toBe('D:\\from-env')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back to the built-in default when nothing is configured', async () => {
    vi.stubEnv('DEVTASK_SOURCE_ROOT', '')
    try {
      await expect(resolveSourceRoot()).resolves.toBe(getSourceRoot())
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
