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
    await expect(
      afterRestart.ensureRunning('STORY-1', workspacesRoot, workspacesRoot),
    ).resolves.toMatchObject({ port: first.port, status: 'running' })
    expect(launch).toHaveBeenCalledTimes(2)
    healthyPorts.delete(first.port)
    await expect(afterRestart.inspect('STORY-1')).resolves.toMatchObject({
      status: 'failed',
      error: 'CodeBuddy service is not responding to health checks.',
    })
    await expect(afterRestart.list()).resolves.toHaveLength(2)
  })

  it('keeps failed port reservations and rejects workspaces outside the configured root', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    const supervisor = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60260,
      portEnd: 60260,
      launch: async () => {
        throw new Error('spawn failed')
      },
      isPortAvailable: async () => true,
      isHealthy: async () => false,
      startupTimeoutMs: 1,
      wait: async () => {},
    })

    await expect(
      supervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot),
    ).rejects.toThrow('spawn failed')
    await expect(
      supervisor.ensureRunning('STORY-2', workspacesRoot, workspacesRoot),
    ).rejects.toThrow('No free Story service port')
    await expect(
      supervisor.ensureRunning('STORY-3', join(workspacesRoot, '..', 'outside'), workspacesRoot),
    ).rejects.toThrow('inside the configured workspaces root')
    await expect(supervisor.get('STORY-1')).resolves.toMatchObject({
      status: 'failed',
      port: 60260,
    })
  })

  it('启动后健康检查超时时结束进程并保留 PID', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    let portBusy = false
    const killProcessTree = vi.fn(async () => {
      portBusy = false
    })
    const supervisor = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60280,
      portEnd: 60280,
      launch: async () => {
        portBusy = true
        return 5678
      },
      isPortAvailable: async () => !portBusy,
      isHealthy: async () => false,
      wait: async () => {},
      startupTimeoutMs: 1,
      killProcessTree,
    })

    await expect(
      supervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot),
    ).rejects.toThrow('startup timeout')
    // 已拉起的进程必须被结束，否则端口一直被占用、停止与重启都无从下手
    expect(killProcessTree).toHaveBeenCalledWith(5678, 'STORY-1')
    await expect(supervisor.get('STORY-1')).resolves.toMatchObject({
      status: 'failed',
      pid: 5678,
      error: expect.not.stringContaining('清理未完成'),
    })
  })

  it('清理后端口仍未释放时保留 PID 并如实记录原因', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    let portBusy = false
    const supervisor = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60290,
      portEnd: 60290,
      launch: async () => {
        portBusy = true
        return 6789
      },
      isPortAvailable: async () => !portBusy,
      isHealthy: async () => false,
      wait: async () => {},
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      killProcessTree: async () => {},
    })

    await expect(
      supervisor.ensureRunning('STORY-1', workspacesRoot, workspacesRoot),
    ).rejects.toThrow('startup timeout')
    await expect(supervisor.get('STORY-1')).resolves.toMatchObject({
      status: 'failed',
      pid: 6789,
      error: expect.stringContaining('启动失败后进程清理未完成'),
    })
  })

  it('重启后仍能以保留的 PID 停止残留进程', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-story-services-'))
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspaces-'))
    let portBusy = false
    const failing = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60300,
      portEnd: 60300,
      launch: async () => {
        portBusy = true
        return 7890
      },
      isPortAvailable: async () => !portBusy,
      isHealthy: async () => false,
      wait: async () => {},
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      killProcessTree: async () => {},
    })
    await expect(failing.ensureRunning('STORY-1', workspacesRoot, workspacesRoot)).rejects.toThrow()

    const restarted = new StoryServiceSupervisor({
      dataDirectory,
      portStart: 60300,
      portEnd: 60300,
      launch: async () => 1,
      isPortAvailable: async () => !portBusy,
      isHealthy: async () => false,
      wait: async () => {},
      stopTimeoutMs: 1,
      killProcessTree: async (pid: number | string) => {
        expect(pid).toBe(7890)
        portBusy = false
      },
    })
    await expect(restarted.stop('STORY-1')).resolves.toMatchObject({ status: 'stopped', pid: 7890 })
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
