import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTransportFailure, McpClientRegistry } from './mcp-client.js'

let tempDirectory: string | undefined
const previousConfigPath = process.env.DEVTASK_MCP_CONFIG

afterEach(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  if (previousConfigPath === undefined) delete process.env.DEVTASK_MCP_CONFIG
  else process.env.DEVTASK_MCP_CONFIG = previousConfigPath
  tempDirectory = undefined
})

/**
 * 写入一份临时 MCP 配置并指向它。
 * @param servers mcpServers 内容
 * @returns Promise<void>
 */
async function useConfig(servers: Record<string, unknown>): Promise<void> {
  tempDirectory = await mkdtemp(join(tmpdir(), 'devtask-mcp-client-'))
  const configPath = join(tempDirectory, 'mcp.json')
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }), 'utf8')
  process.env.DEVTASK_MCP_CONFIG = configPath
}

describe('MCP transport failure classification', () => {
  it('rebuilds the connection only for transport-level failures', () => {
    // 子进程退出 / 管道断开：需要重连
    expect(isTransportFailure(new Error('McpError: MCP error -32000: Connection closed'))).toBe(true)
    expect(isTransportFailure(new Error('socket hang up'))).toBe(true)
    expect(isTransportFailure(new Error('read EPIPE'))).toBe(true)
    expect(isTransportFailure(new Error('client is closed'))).toBe(true)

    // 业务错误与上游限流：重连没用，只会多打一次上游
    expect(isTransportFailure(new Error('TAPD get_bug returned an error.'))).toBe(false)
    expect(isTransportFailure(new Error('TAPD request failed with HTTP 429.'))).toBe(false)
  })
})

describe('MCP client registry', () => {
  it('returns null for a server that is not configured', async () => {
    await useConfig({})

    await expect(new McpClientRegistry().listTools('Missing_Server')).resolves.toBeNull()
  })

  it('explains startup failures and redacts configured secrets', async () => {
    const secret = 'secret-token-value-123'
    await useConfig({
      Fake_Server: {
        command: process.execPath,
        args: ['-e', `console.error('Error: HTTPError 429 TooManyRequest ${secret}');process.exit(1)`],
        env: { FAKE_TOKEN: secret },
      },
    })
    const registry = new McpClientRegistry()

    const error = await registry.listTools('Fake_Server').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('Fake_Server MCP 启动失败')
    expect(message).toContain('429')
    expect(message).not.toContain(secret)
  }, 30_000)

  it('reuses the last failure during the cooldown instead of respawning', async () => {
    await useConfig({
      Slow_Fail_Server: {
        command: 'definitely-not-a-real-command-xyz',
        args: [],
      },
    })
    const registry = new McpClientRegistry()
    const firstStartedAt = Date.now()
    const first = await registry.listTools('Slow_Fail_Server').catch((cause: unknown) => cause)
    // 命令不存在属于确定性失败，不应触发重试等待
    expect(Date.now() - firstStartedAt).toBeLessThan(2_000)

    const startedAt = Date.now()
    const second = await registry.listTools('Slow_Fail_Server').catch((cause: unknown) => cause)

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(second).toBe(first)
  })
})
