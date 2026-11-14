import { describe, expect, it, vi } from 'vitest'
import { ServiceMonitor } from './service-monitor.js'
import type { StoryService, StoryServiceSupervisor } from './story-service-supervisor.js'

/**
 * 构造假的 supervisor。
 * @param services 登记的服务
 * @param inspected 巡检时返回的状态
 * @param ensureRunning 重启实现
 * @returns 桩 supervisor 与关键方法
 */
function stubSupervisor(
  services: StoryService[],
  inspected: StoryService | undefined,
  ensureRunning: () => Promise<StoryService>,
): {
  supervisor: StoryServiceSupervisor
  ensureRunning: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
} {
  const ensure = vi.fn(ensureRunning)
  const inspect = vi.fn().mockResolvedValue(inspected)
  const supervisor = {
    list: vi.fn().mockResolvedValue(services),
    inspect,
    ensureRunning: ensure,
  } as unknown as StoryServiceSupervisor
  return { supervisor, ensureRunning: ensure, inspect }
}

/**
 * 构造一条服务登记。
 * @param status 服务状态
 * @returns 服务登记对象
 */
function service(status: StoryService['status']): StoryService {
  return {
    storyId: 'story-1',
    port: 60201,
    cwd: 'D:/workspaces/ws-a/repo-a',
    status,
    updatedAt: new Date().toISOString(),
  }
}

describe('ServiceMonitor', () => {
  it('服务健康时不产生事件', async () => {
    const { supervisor } = stubSupervisor([service('running')], service('running'), async () => service('running'))
    const monitor = new ServiceMonitor({ supervisor, workspacesRoot: 'D:/workspaces', wait: async () => {} })
    await monitor.tick()
    expect(monitor.list()).toEqual([])
  })

  it('服务不健康时按退避序列重试并记录成功事件', async () => {
    const waits: number[] = []
    const { supervisor, ensureRunning } = stubSupervisor(
      [service('failed')],
      service('failed'),
      async () => service('running'),
    )
    const monitor = new ServiceMonitor({
      supervisor,
      workspacesRoot: 'D:/workspaces',
      wait: async (milliseconds) => { waits.push(milliseconds) },
    })
    await monitor.tick()
    expect(ensureRunning).toHaveBeenCalledTimes(1)
    const events = monitor.list()
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('restart')
    expect(events[0]?.level).toBe('info')
    // 第一次尝试不等待，命中后不再进入后续退避
    expect(waits).toEqual([])
  })

  it('重试耗尽后产生 error 级事件', async () => {
    const waits: number[] = []
    const { supervisor, ensureRunning } = stubSupervisor(
      [service('failed')],
      service('failed'),
      async () => { throw new Error('launch failed') },
    )
    const monitor = new ServiceMonitor({
      supervisor,
      workspacesRoot: 'D:/workspaces',
      retryDelays: [5_000, 15_000, 30_000],
      wait: async (milliseconds) => { waits.push(milliseconds) },
    })
    await monitor.tick()
    expect(ensureRunning).toHaveBeenCalledTimes(4)
    expect(waits).toEqual([5_000, 15_000, 30_000])
    const events = monitor.list()
    const last = events[0]
    expect(last?.level).toBe('error')
    expect(last?.kind).toBe('failed')
    expect(last?.message).toContain('launch failed')
  })

  it('恢复健康后产生 recovered 事件并清零失败计数', async () => {
    const inspect = vi.fn()
    const supervisor = {
      list: vi.fn().mockResolvedValue([service('failed')]),
      inspect,
      ensureRunning: vi.fn().mockRejectedValue(new Error('still down')),
    } as unknown as StoryServiceSupervisor
    const monitor = new ServiceMonitor({
      supervisor,
      workspacesRoot: 'D:/workspaces',
      retryDelays: [],
      wait: async () => {},
    })
    inspect.mockResolvedValueOnce(service('failed'))
    await monitor.tick()
    expect(monitor.list()[0]?.kind).toBe('failed')
    // 一次失败巡检会产生「重试失败」与「重试耗尽」两条事件
    const afterFailure = monitor.list().length

    inspect.mockResolvedValueOnce(service('running'))
    await monitor.tick()
    expect(monitor.list()[0]?.kind).toBe('recovered')
    expect(monitor.list()).toHaveLength(afterFailure + 1)

    // 失败计数已清零，再巡检不会重复产生 recovered
    inspect.mockResolvedValueOnce(service('running'))
    await monitor.tick()
    expect(monitor.list()).toHaveLength(afterFailure + 1)
  })

  it('跳过主动停止的服务', async () => {
    const { supervisor, inspect } = stubSupervisor([service('stopped')], service('stopped'), async () => service('running'))
    const monitor = new ServiceMonitor({ supervisor, workspacesRoot: 'D:/workspaces', wait: async () => {} })
    await monitor.tick()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('事件缓冲受上限约束', async () => {
    const { supervisor } = stubSupervisor([service('failed')], service('failed'), async () => {
      throw new Error('down')
    })
    const monitor = new ServiceMonitor({
      supervisor,
      workspacesRoot: 'D:/workspaces',
      retryDelays: [],
      maxEvents: 3,
      wait: async () => {},
    })
    for (let index = 0; index < 5; index += 1) await monitor.tick()
    expect(monitor.list(100)).toHaveLength(3)
  })

  it('巡检并发时不会重入', async () => {
    let resolveInspect: (value: StoryService) => void = () => {}
    const pending = new Promise<StoryService>((resolve) => { resolveInspect = resolve })
    const inspect = vi.fn().mockReturnValue(pending)
    const supervisor = {
      list: vi.fn().mockResolvedValue([service('running')]),
      inspect,
      ensureRunning: vi.fn(),
    } as unknown as StoryServiceSupervisor
    const monitor = new ServiceMonitor({ supervisor, workspacesRoot: 'D:/workspaces', wait: async () => {} })
    const first = monitor.tick()
    const second = monitor.tick()
    resolveInspect(service('running'))
    await Promise.all([first, second])
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
