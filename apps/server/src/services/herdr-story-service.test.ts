import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const killProcessTreeMock = vi.hoisted(() => vi.fn<(pid: number) => Promise<void>>())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('./story-service-supervisor.js', () => ({ killProcessTree: killProcessTreeMock }))

import {
  HERDR_LAUNCHER_ENV,
  createHerdrLifecycle,
  createHerdrRunner,
  resolveStoryServiceLauncher,
  storyServiceWorkspaceLabel,
} from './herdr-story-service.js'

/**
 * 构造记录调用序列的假 herdr 调用器。
 * @param respond 依据参数返回 `result` 的桩
 * @returns `run` 调用器与 `calls` 调用记录
 */
function createFakeRunner(respond: (args: string[]) => unknown) {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<unknown> => {
    calls.push(args)
    return respond(args)
  }
  return { run, calls }
}

/**
 * 让 `execFile` 的替身按指定 stdout 触发成功或失败回调。
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

beforeEach(() => {
  execFileMock.mockReset()
  killProcessTreeMock.mockReset()
  killProcessTreeMock.mockResolvedValue(undefined)
})

describe('storyServiceWorkspaceLabel', () => {
  it('encodes the story id into a stable workspace label', () => {
    expect(storyServiceWorkspaceLabel('STORY-1')).toBe('devtask-story:STORY-1')
  })
})

describe('resolveStoryServiceLauncher', () => {
  it('defaults to app-hc and only switches on explicit herdr/spawn values', () => {
    expect(resolveStoryServiceLauncher({})).toBe('app-hc')
    expect(resolveStoryServiceLauncher({ [HERDR_LAUNCHER_ENV]: 'herdr' })).toBe('herdr')
    expect(resolveStoryServiceLauncher({ [HERDR_LAUNCHER_ENV]: 'anything-else' })).toBe('app-hc')
    expect(resolveStoryServiceLauncher({ [HERDR_LAUNCHER_ENV]: ' SPAWN ' })).toBe('spawn')
    expect(resolveStoryServiceLauncher({ [HERDR_LAUNCHER_ENV]: 'app-hc' })).toBe('app-hc')
  })
})

describe('createHerdrLifecycle launch', () => {
  it('replaces the previous workspace, runs serve in the new pane and returns its shell pid', async () => {
    const label = storyServiceWorkspaceLabel('STORY-1')
    const { run, calls } = createFakeRunner((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return {
          workspaces: [
            { workspace_id: 'w1', label },
            { workspace_id: 'w2', label: 'other' },
          ],
        }
      }
      if (args[0] === 'workspace' && args[1] === 'close') return { type: 'ok' }
      if (args[0] === 'workspace' && args[1] === 'create') {
        return { root_pane: { pane_id: 'w9:p1' }, workspace: { workspace_id: 'w9', label } }
      }
      if (args[0] === 'pane' && args[1] === 'run') return { type: 'ok' }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { process_info: { pane_id: 'w9:p1', shell_pid: 4321 } }
      }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`)
    })
    const lifecycle = createHerdrLifecycle(run)

    await expect(lifecycle.launch('C:\\workspace', 60300, 'STORY-1')).resolves.toBe(4321)

    // 旧 workspace 必须先关掉，否则复用的 pane 会让 shell_pid 保持不变
    expect(calls).toContainEqual(['workspace', 'close', 'w1'])
    expect(calls).not.toContainEqual(['workspace', 'close', 'w2'])
    expect(calls).toContainEqual([
      'workspace',
      'create',
      '--cwd',
      'C:\\workspace',
      '--label',
      label,
      '--no-focus',
    ])
    const runCall = calls.find((args) => args[0] === 'pane' && args[1] === 'run')
    expect(runCall?.[2]).toBe('w9:p1')
    expect(runCall?.[3]).toContain('--port 60300')
    expect(runCall?.[3]).toContain('--auth none')
    expect(calls).toContainEqual(['pane', 'process-info', '--pane', 'w9:p1'])
  })

  it('rejects when workspace create does not return a root pane', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') return { workspaces: [] }
      if (args[0] === 'workspace' && args[1] === 'create')
        return { workspace: { workspace_id: 'w9' } }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`)
    })
    const lifecycle = createHerdrLifecycle(run)

    await expect(lifecycle.launch('C:\\workspace', 60301, 'STORY-2')).rejects.toThrow(
      'herdr workspace create did not return a root pane.',
    )
  })

  it('rejects when process-info does not return a usable pid', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') return { workspaces: [] }
      if (args[0] === 'workspace' && args[1] === 'create') {
        return { root_pane: { pane_id: 'w9:p1' }, workspace: { workspace_id: 'w9' } }
      }
      if (args[0] === 'pane' && args[1] === 'run') return { type: 'ok' }
      if (args[0] === 'pane' && args[1] === 'process-info')
        return { process_info: { shell_pid: 0 } }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`)
    })
    const lifecycle = createHerdrLifecycle(run)

    await expect(lifecycle.launch('C:\\workspace', 60302, 'STORY-3')).rejects.toThrow(
      'herdr pane process-info did not return a usable shell pid.',
    )
  })
})

describe('createHerdrLifecycle stop', () => {
  it('closes the owned workspace and never falls back to taskkill', async () => {
    const label = storyServiceWorkspaceLabel('STORY-1')
    const { run, calls } = createFakeRunner((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return { workspaces: [{ workspace_id: 'w7', label }] }
      }
      if (args[0] === 'workspace' && args[1] === 'close') return { type: 'ok' }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`)
    })
    const lifecycle = createHerdrLifecycle(run)

    await lifecycle.stop(4321, 'STORY-1')

    expect(calls).toContainEqual(['workspace', 'close', 'w7'])
    expect(killProcessTreeMock).not.toHaveBeenCalled()
  })

  it('falls back to killing the process tree when no workspace owns the story', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') return { workspaces: [] }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`)
    })
    const lifecycle = createHerdrLifecycle(run)

    await lifecycle.stop(4321, 'STORY-1')

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321)
  })
})

describe('createHerdrRunner', () => {
  it('unwraps the result field from the response envelope', async () => {
    stubExecFile('{"id":"cli:workspace:list","result":{"workspaces":[]}}\n')

    await expect(createHerdrRunner()(['workspace', 'list'])).resolves.toEqual({ workspaces: [] })
  })

  it('treats non-JSON output as a failure', async () => {
    stubExecFile('unsupported interactive agent kind: codebuddy\n')

    await expect(createHerdrRunner()(['agent', 'start'])).rejects.toThrow(
      'returned non-JSON output',
    )
  })

  it('treats an error envelope as a failure', async () => {
    stubExecFile('{"id":"cli:pane:close","error":{"code":"PANE_NOT_FOUND"}}')

    await expect(createHerdrRunner()(['pane', 'close', 'w1:p1'])).rejects.toThrow('failed')
  })

  it('surfaces exec failures with an actionable fallback hint', async () => {
    stubExecFile('', new Error('spawn herdr ENOENT'))
    const run = createHerdrRunner()

    await expect(run(['workspace', 'list'])).rejects.toThrow('spawn herdr ENOENT')
    await expect(run(['workspace', 'list'])).rejects.toThrow(`${HERDR_LAUNCHER_ENV}=spawn`)
  })
})
