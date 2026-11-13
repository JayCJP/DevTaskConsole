import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceInitializer } from './initializer.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

describe('workspace initialization job persistence', () => {
  it('restores job history and marks orphaned running jobs as interrupted', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-initializer-'))
    const jobsPath = join(dataDirectory, 'workspace-initialization-jobs.json')
    await writeFile(jobsPath, JSON.stringify([
      {
        id: '00e3f7b8-5cc0-444e-9ca0-708dc19324b2',
        workspaceName: 'feature-one',
        status: 'running',
        stage: 'install',
        logs: ['Installing dependencies.'],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        exitCode: null,
      },
    ]))

    const initializer = new WorkspaceInitializer({ dataDirectory })
    const job = await initializer.getJob('00e3f7b8-5cc0-444e-9ca0-708dc19324b2')
    const persisted = JSON.parse(await readFile(jobsPath, 'utf8')) as Array<{ status: string }>

    expect(job).toMatchObject({
      status: 'interrupted',
      stage: 'failed',
      exitCode: null,
      logs: [
        'Installing dependencies.',
        'The server restarted while this job was running; its process state is unknown.',
      ],
    })
    expect(persisted[0]?.status).toBe('interrupted')
  })

  it('surfaces corrupted persisted job state', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-initializer-'))
    await writeFile(join(dataDirectory, 'workspace-initialization-jobs.json'), '{')
    const initializer = new WorkspaceInitializer({ dataDirectory })

    await expect(initializer.getJob('missing')).rejects.toThrow('contains invalid JSON')
  })
})
