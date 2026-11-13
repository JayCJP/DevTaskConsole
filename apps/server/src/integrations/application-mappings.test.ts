import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationMappingStore } from './application-mappings.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

describe('application mappings', () => {
  it('persists explicit repo mappings and serializes concurrent updates', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-app-mappings-'))
    const store = new ApplicationMappingStore(dataDirectory)

    await Promise.all([
      store.upsert({ repoName: 'front-repo', gitlabProjectId: 12 }),
      store.upsert({ repoName: 'api-repo', devopsApp: 'API', devopsGroup: 'Frontend' }),
    ])

    await expect(store.list()).resolves.toEqual([
      { repoName: 'api-repo', devopsApp: 'API', devopsGroup: 'Frontend' },
      { repoName: 'front-repo', gitlabProjectId: 12 },
    ])
  })

  it('rejects mappings without a complete external-system association', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-app-mappings-'))
    const store = new ApplicationMappingStore(dataDirectory)

    await expect(store.upsert({ repoName: 'api-repo', devopsApp: 'API' }))
      .rejects.toThrow('Application mapping parameters are invalid.')
    await expect(store.list()).resolves.toEqual([])
  })
})
