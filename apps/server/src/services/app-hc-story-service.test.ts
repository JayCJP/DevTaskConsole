import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { HERDR_LAUNCHER_ENV } from './herdr-story-service.js'
import { CliError, createAppHcLifecycle, createCliRunner } from './app-hc-story-service.js'

/**
 * 让 execFile 替身按指定 stdout 触发回调。
 * @param stdout 期望返回的标准输出
 * @param error 传入时模拟调用失败
 * @returns 无返回值
 */
function stubExecFile(stdout: string, error?: Error): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      callback(error ?? null, error ? undefined : { stdout, stderr: '' })
    },
  )
}

/**
 * 记录调用序列的调用器替身。
 * @param respond 依据参数返回结果的桩
 * @returns run 调用器与 calls 调用记录
 */
function createFakeRunner(respond: (args: string[]) => unknown) {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<unknown> => {
    calls.push(args)
    return respond(args)
  }
  return { run, calls }
}

beforeEach(() => {
  execFileMock.mockReset()
})

describe('createCliRunner', () => {
  it('returns the parsed JSON when stdout is a valid object', async () => {
    stubExecFile('{"space":"sp1","tab":"tb1","terminal":"t1"}\n')

    await expect(createCliRunner('herdr-app')(['do', 'tab.new'])).resolves.toEqual({
      space: 'sp1',
      tab: 'tb1',
      terminal: 't1',
    })
  })

  it('treats non-JSON output as a failure', async () => {
    stubExecFile('error: window is closed\n')

    await expect(createCliRunner('herdr-app')(['do', 'tab.new'])).rejects.toThrow(
      'returned non-JSON output',
    )
  })

  it('treats an error envelope as a failure even on exit code 0, preserving its kind', async () => {
    // 关键回归：hc kill 对不存在的终端返回 error 但 exit code 仍为 0
    stubExecFile('{"error":{"kind":"not_found","message":"no terminal \\"t1\\""}}')

    const run = createCliRunner('hc')
    await expect(run(['kill', 't1'])).rejects.toMatchObject({
      name: 'CliError',
      kind: 'not_found',
    })
  })

  it('treats a string error field (herdr-app do) as a failure', async () => {
    stubExecFile('{"error":"no running terminal \\"t1\\""}')

    await expect(createCliRunner('herdr-app')(['do', 'terminal.keep'])).rejects.toThrow('failed')
  })

  it('surfaces exec failures with an actionable fallback hint', async () => {
    stubExecFile('', new Error('spawn herdr-app ENOENT'))
    const run = createCliRunner('herdr-app')

    await expect(run(['ls'])).rejects.toThrow('spawn herdr-app ENOENT')
    await expect(run(['ls'])).rejects.toThrow(`${HERDR_LAUNCHER_ENV}=herdr`)
  })
})

describe('createAppHcLifecycle launch', () => {
  it('creates a tab with correct argv and folder, disables keep and returns the terminal address', async () => {
    const appCalls: string[][] = []
    const hcCalls: string[][] = []
    const appRun = createFakeRunner((args) => {
      appCalls.push(args)
      if (args[0] === 'ls') {
        return {
          spaces: [{ id: 'sp1', name: 'devtask-services', tabs: [] }],
        }
      }
      if (args[0] === 'do' && args[1] === 'tab.new') {
        return { space: 'sp1', tab: 'tb9', terminal: 't9' }
      }
      throw new Error(`unexpected herdr-app call: ${args.join(' ')}`)
    })
    const hcRun = createFakeRunner((args) => {
      hcCalls.push(args)
      if (args[0] === 'get') return { state: 'live', foreground: { pid: 4242 } }
      if (args[0] === 'keep') return {}
      throw new Error(`unexpected hc call: ${args.join(' ')}`)
    })
    const lifecycle = createAppHcLifecycle(appRun.run, hcRun.run, 'D:\\workspace-root')

    await expect(lifecycle.launch('D:\\workspace', 60300, 'STORY-1')).resolves.toBe('t9')

    const tabNew = appCalls.find((args) => args[1] === 'tab.new')
    expect(tabNew).toBeDefined()
    expect(tabNew).toContain('--name')
    expect(tabNew?.[tabNew.indexOf('--name') + 1]).toBe('STORY-1')
    expect(tabNew).toContain('--folder')
    expect(tabNew?.[tabNew.indexOf('--folder') + 1]).toBe('D:\\workspace')
    expect(tabNew).toContain('--space')
    expect(tabNew?.[tabNew.indexOf('--space') + 1]).toBe('sp1')
    const argvIndex = tabNew?.indexOf('--argv') ?? -1
    const argv = JSON.parse(tabNew?.[argvIndex + 1] ?? '[]') as string[]
    expect(argv).toContain('--port')
    expect(argv[argv.indexOf('--port') + 1]).toBe('60300')
    expect(argv).toContain('--auth')
    expect(argv).toContain('--permission-mode')

    expect(hcCalls).toContainEqual(['keep', 't9', '--off'])
    expect(hcCalls).toContainEqual(['get', 't9'])
  })

  it('closes the old terminal with the same story name before creating a new tab', async () => {
    // 用共享事件序列断言「先关旧 terminal、再建新 tab」的时序，防止回归成先建后杀
    const events: string[] = []
    const appRun = createFakeRunner((args) => {
      if (args[0] === 'ls') {
        return {
          spaces: [
            {
              id: 'sp1',
              name: 'devtask-services',
              tabs: [{ id: 'tb1', name: 'STORY-1', terminals: [{ terminal: 't7' }] }],
            },
          ],
        }
      }
      if (args[0] === 'do' && args[1] === 'tab.new') {
        events.push('tab.new')
        return { terminal: 't8' }
      }
      throw new Error(`unexpected herdr-app call: ${args.join(' ')}`)
    })
    const hcRun = createFakeRunner((args) => {
      if (args[0] === 'kill' && args[1] === 't7') events.push('kill:old')
      if (args[0] === 'rm' && args[1] === 't7') events.push('rm:old')
      if (args[0] === 'get') return { foreground: { pid: 1111 } }
      return {}
    })
    const lifecycle = createAppHcLifecycle(appRun.run, hcRun.run, 'D:\\root')

    await expect(lifecycle.launch('D:\\workspace', 60301, 'STORY-1')).resolves.toBe('t8')

    expect(events).toEqual(['kill:old', 'rm:old', 'tab.new'])
  })

  it('retries hc get when foreground pid is not ready yet', async () => {
    let getCount = 0
    const hcRun = createFakeRunner((args) => {
      if (args[0] === 'get') {
        getCount += 1
        return getCount === 1 ? { state: 'live' } : { foreground: { pid: 2222 } }
      }
      return {}
    })
    const appRun = createFakeRunner((args) => {
      if (args[0] === 'ls') return { spaces: [] }
      if (args[0] === 'do' && args[1] === 'space.new') return { space: 'sp2' }
      if (args[0] === 'do' && args[1] === 'tab.new') return { terminal: 't3' }
      throw new Error(`unexpected herdr-app call: ${args.join(' ')}`)
    })
    const lifecycle = createAppHcLifecycle(appRun.run, hcRun.run, 'D:\\root')

    await expect(lifecycle.launch('D:\\workspace', 60302, 'STORY-2')).resolves.toBe('t3')
    expect(getCount).toBe(2)
  })

  it('rejects when tab.new does not return a terminal address', async () => {
    const appRun = createFakeRunner((args) => {
      if (args[0] === 'ls') return { spaces: [] }
      if (args[0] === 'do' && args[1] === 'space.new') return { space: 'sp2' }
      if (args[0] === 'do' && args[1] === 'tab.new') return { space: 'sp2', tab: 'tb2' }
      throw new Error(`unexpected herdr-app call: ${args.join(' ')}`)
    })
    const hcRun = createFakeRunner(() => ({}))
    const lifecycle = createAppHcLifecycle(appRun.run, hcRun.run, 'D:\\root')

    await expect(lifecycle.launch('D:\\workspace', 60303, 'STORY-3')).rejects.toThrow(
      'tab.new did not return a terminal address',
    )
  })
})

describe('createAppHcLifecycle stop', () => {
  it('kills and removes the terminal by address', async () => {
    const hcCalls: string[][] = []
    const hcRun = createFakeRunner((args) => {
      hcCalls.push(args)
      return {}
    })
    const lifecycle = createAppHcLifecycle(createFakeRunner(() => ({})).run, hcRun.run, 'D:\\root')

    await lifecycle.stop('t5', 'STORY-1')

    expect(hcCalls).toContainEqual(['kill', 't5'])
    expect(hcCalls).toContainEqual(['rm', 't5'])
  })

  it('is idempotent when the terminal has already gone (not_found error)', async () => {
    // 回归：hc 对不存在的终端返回 error 但 exit code 仍为 0，runner 抛 CliError，这里必须吞掉
    const hcRun = createFakeRunner(() => {
      throw new CliError('hc kill t5 failed: {"kind":"not_found"}', 'not_found')
    })
    const lifecycle = createAppHcLifecycle(createFakeRunner(() => ({})).run, hcRun.run, 'D:\\root')

    await expect(lifecycle.stop('t5', 'STORY-1')).resolves.toBeUndefined()
  })

  it('propagates a real CLI failure instead of silently swallowing it', async () => {
    // stop 只应吞 not_found；CLI 故障必须透传，不能让调用方误以为停止成功
    const hcRun = createFakeRunner(() => {
      throw new CliError('hc server unavailable', 'connection_error')
    })
    const lifecycle = createAppHcLifecycle(createFakeRunner(() => ({})).run, hcRun.run, 'D:\\root')

    await expect(lifecycle.stop('t5', 'STORY-1')).rejects.toThrow('hc server unavailable')
  })
})
