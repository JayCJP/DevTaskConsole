import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ServiceEvent } from '@devtask/shared'
import { StoryServiceSupervisor } from './story-service-supervisor.js'

interface ServiceMonitorOptions {
  /** 服务登记与生命周期实现的拥有者 */
  supervisor: StoryServiceSupervisor
  /** 工作区根目录，重启服务时用于校验 cwd 仍合法 */
  workspacesRoot: string
  /** 巡检间隔毫秒，默认 30 秒 */
  intervalMs?: number
  /** 重启重试的等待序列，默认 5/15/30 秒 */
  retryDelays?: number[]
  /** 可注入的等待实现，测试时用于跳过真实等待 */
  wait?: (milliseconds: number) => Promise<void>
  /** 事件环形缓冲上限，默认 200 */
  maxEvents?: number
}

/**
 * Story 服务运行期监督器。
 * 以固定间隔巡检已登记服务：进程崩溃时按 5/15/30 秒退避重启；
 * 重试耗尽后标记失败并产生 error 级事件，供前端「监督提醒条」展示，
 * 避免服务静默失效。事件只在内存中保留最近若干条，不落盘、不累积。
 */
export class ServiceMonitor {
  private readonly supervisor: StoryServiceSupervisor
  private readonly workspacesRoot: string
  private readonly intervalMs: number
  private readonly retryDelays: number[]
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly maxEvents: number
  private readonly events: ServiceEvent[] = []
  /** 每个 Story 连续重启失败的次数，恢复后清零 */
  private readonly failures = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private stopped = true

  constructor(options: ServiceMonitorOptions) {
    this.supervisor = options.supervisor
    this.workspacesRoot = options.workspacesRoot
    this.intervalMs = options.intervalMs ?? 30_000
    this.retryDelays = options.retryDelays ?? [5_000, 15_000, 30_000]
    this.wait = options.wait ?? delay
    this.maxEvents = options.maxEvents ?? 200
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new Error('Service monitor interval must be at least 1000 ms.')
    }
  }

  /**
   * 启动周期巡检。重复调用无副作用。
   * @returns 无返回值；定时器 unref 后不会阻止进程退出
   */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // 巡检异常不能中断后续巡检；具体错误已通过事件暴露
      })
    }, this.intervalMs)
    this.timer.unref?.()
  }

  /**
   * 停止巡检并清除定时器。
   * @returns 无返回值
   */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 读取最近的监督事件（按时间倒序）。
   * @param limit 返回条数上限，默认 50
   * @returns 事件数组
   */
  list(limit = 50): ServiceEvent[] {
    return [...this.events].reverse().slice(0, Math.max(1, Math.min(200, limit)))
  }

  /**
   * 执行一次巡检。
   * 对每个非 stopped 服务做健康检查；不健康则按退避序列尝试重启。
   * @returns Promise<void>
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const services = await this.supervisor.list()
      for (const service of services) {
        if (service.status === 'stopped') continue
        const inspected = await this.supervisor.inspect(service.storyId)
        if (!inspected) continue
        if (inspected.status === 'running') {
          if ((this.failures.get(service.storyId) ?? 0) > 0) {
            this.failures.delete(service.storyId)
            this.push(service.storyId, 'info', 'recovered', '服务已恢复健康。')
          }
          continue
        }
        await this.restart(service.storyId, service.cwd, service.pid)
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * 按退避序列重启单个服务。
   * 若 `ensureRunning` 复用原进程（pid 未变），说明只是健康检查抖动，
   * 事件文案必须如实写成「恢复响应」而不是「重启成功」，避免误导。
   * @param storyId Story 标识
   * @param cwd 服务工作目录
   * @param previousPid 巡检前登记的进程号，用于判断是否真的换过进程
   * @returns Promise<void>
   */
  private async restart(storyId: string, cwd: string, previousPid?: number): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
      const retryDelay = this.retryDelays[attempt - 1]
      if (retryDelay !== undefined) await this.wait(retryDelay)
      try {
        const service = await this.supervisor.ensureRunning(storyId, cwd, this.workspacesRoot)
        this.failures.delete(storyId)
        const restarted = previousPid !== undefined && service.pid !== previousPid
        this.push(
          storyId,
          'info',
          'restart',
          restarted ? `第 ${attempt + 1} 次自动重启成功。` : '服务重新响应健康检查，进程未重启。',
        )
        return
      } catch (error) {
        lastError = error
        this.push(
          storyId,
          'warning',
          'restart',
          `第 ${attempt + 1} 次自动重启失败：${messageOf(error)}`,
        )
      }
    }
    const failures = (this.failures.get(storyId) ?? 0) + 1
    this.failures.set(storyId, failures)
    this.push(storyId, 'error', 'failed', `自动重启已耗尽，服务仍不可用：${messageOf(lastError)}`)
  }

  /**
   * 写入一条监督事件，并维持环形缓冲上限。
   * @param storyId Story 标识
   * @param level 事件级别
   * @param kind 事件类型
   * @param message 可读说明
   * @returns 无返回值
   */
  private push(storyId: string, level: ServiceEvent['level'], kind: ServiceEvent['kind'], message: string): void {
    this.events.push({
      id: randomUUID(),
      storyId,
      level,
      kind,
      message,
      createdAt: new Date().toISOString(),
    })
    while (this.events.length > this.maxEvents) this.events.shift()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
