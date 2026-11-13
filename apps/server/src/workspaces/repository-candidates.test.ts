import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listRepositoryCandidates } from './repository-candidates.js'

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
