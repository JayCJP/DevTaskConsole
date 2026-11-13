import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoryServiceSupervisor } from './story-service-supervisor.js'

let dataDirectory: string | undefined
let workspacesRoot: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  dataDirectory = undefined
  workspacesRoot = undefined
})

describe('StoryServiceSupervisor', () => {
  it('reserves one stable port per story and adopts healthy services after reconstruction', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    const healthyPorts = new Set<number>()
    const launch = vi.fn(async (_cwd: string, port: number) => {
      healthyPorts.add(port)
      return 1234
    })
    const options = {
      dataDirectory,
      portStart: 60250,
      portEnd: 60251,
      launch,
      isPortAvailable: async () => true,
      isHealthy: async (port: number) => healthyPorts.has(port),
      wait: async () => {},
      startupTimeoutMs: 100,
    }
    const supervisor = new StoryServiceSupervisor(options)

    const first = await supervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot)
    const second = await supervisor.ensureRunning('STORY-2', workspacesRoot, workspacesRoot)
    const afterRestart = new StoryServiceSupervisor({ ...options, launch: vi.fn() })

    expect(first).toMatchObject({ storyId: 'STORY-1', port: 60250, status: 'running', pid: 1234 })
    expect(second).toMatchObject({ storyId: 'STORY-2', port: 60251, status: 'running' })
    await expect(afterRestart.ensureRunning('STORY-1', workspacesRoot, workspacesRoot))
      .resolves.toMatchObject({ port: first.port, status: 'running' })
    expect(launch).toHaveBeenCalledTimes(2)
    healthyPorts.delete(first.port)
    await expect(afterRestart.inspect('STORY-1'))
      .resolves.toMatchObject({ status: 'failed', error: 'CodeBuddy service is not responding to health checks.' })
    await expect(afterRestart.list()).resolves.toHaveLength(2)
  })

  it('keeps failed port reservations and rejects workspaces outside the configured root', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    const supervisor = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60260,
      portEnd: 60260,
      launch: async () => { throw new Error('spawn failed') },
      isPortAvailable: async () => true,
      isHealthy: async () => false,
      startupTimeoutMs: 1,
      wait: async () => {},
    })

    await expect(supervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot)).rejects.toThrow('spawn failed')
    await expect(supervisor.ensureRunning('STORY-2', workspacesRoot, workspacesRoot))
      .rejects.toThrow('No free Story service port')
    await expect(supervisor.ensureRunning('STORY-3', join(workspacesRoot, '..', 'outside'), workspacesRoot))
      .rejects.toThrow('inside the configured workspaces root')
    await expect(supervisor.get('STORY-1')).resolves.toMatchObject({ status: 'failed', port: 60260 })
  })

  it('restarts persisted unhealthy services with the configured backoff', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    const healthyPorts = new Set<number>()
    const initialSupervisor = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60270,
      portEnd: 60270,
      launch: async (_cwd, port) => {
        healthyPorts.add(port)
        return 1234
      },
      isPortAvailable: async () => true,
      isHealthy: async (port) => healthyPorts.has(port),
      wait: async () => {},
    })
    await initialSupervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot)
    healthyPorts.clear()

    let launchAttempts = 0
    const retryWait = vi.fn(async () => {})
    const recoveringSupervisor = new StoryServiceSupervisor({
      dataDirectory,
      launch: async (_cwd, port) => {
        launchAttempts += 1
        if (launchAttempts === 1) throw new Error('temporary spawn failure')
        healthyPorts.add(port)
        return 4321
      },
      isPortAvailable: async () => true,
      isHealthy: async (port) => healthyPorts.has(port),
      wait: async () => {},
      retryWait,
    })

    await recoveringSupervisor.recoverPersistedServices(workspacesRoot)

    expect(launchAttempts).toBe(2)
    expect(retryWait).toHaveBeenCalledWith(5_000)
    await expect(recoveringSupervisor.get('STORY-1')).resolves.toMatchObject({
      status: 'running',
      port: 60270,
      pid: 4321,
    })
  })
})
