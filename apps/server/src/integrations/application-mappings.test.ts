import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDevOpsGroup } from '@devtask/shared'
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

  it('does not persist mappings that equal the default name assumption', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-app-mappings-'))
    const store = new ApplicationMappingStore(dataDirectory)
    await store.upsert({ repoName: 'front-repo', devopsApp: 'Frontend', devopsGroup: 'JenkinsFrontweb' })

    // 与默认约定一致（应用名 == 仓库名）时不应留下记录，而是回归默认
    await expect(store.upsert({
      repoName: 'front-repo',
      devopsApp: 'front-repo',
      devopsGroup: defaultDevOpsGroup,
    })).resolves.toEqual([])

    await expect(store.list()).resolves.toEqual([])
  })

  it('removes a saved difference mapping so the repository falls back to defaults', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-app-mappings-'))
    const store = new ApplicationMappingStore(dataDirectory)
    await store.upsert({ repoName: 'front-repo', gitlabProjectId: 12 })
    await store.upsert({ repoName: 'api-repo', devopsApp: 'API', devopsGroup: 'Frontend' })

    await expect(store.remove('front-repo')).resolves.toEqual([
      { repoName: 'api-repo', devopsApp: 'API', devopsGroup: 'Frontend' },
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
