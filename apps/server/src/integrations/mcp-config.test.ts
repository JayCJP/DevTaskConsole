import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMcpServerConfig } from './mcp-config.js'

let tempDirectory: string | undefined

afterEach(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  tempDirectory = undefined
})

describe('MCP configuration', () => {
  it('loads one server configuration without exposing environment values in errors', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'devtask-mcp-config-'))
    const configPath = join(tempDirectory, 'mcp.json')
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        TAPD_MCP_Server: {
          command: 'npx',
          args: ['--yes', 'example-server'],
          env: { TAPD_ACCESS_TOKEN: 'private-value' },
        },
      },
    }))

    await expect(loadMcpServerConfig('TAPD_MCP_Server', configPath)).resolves.toEqual({
      command: 'npx',
      args: ['--yes', 'example-server'],
      env: { TAPD_ACCESS_TOKEN: 'private-value' },
    })
    await expect(loadMcpServerConfig('missing', configPath)).resolves.toBeNull()
  })

  it('reports malformed configuration without echoing its contents', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'devtask-mcp-config-'))
    const configPath = join(tempDirectory, 'mcp.json')
    await writeFile(configPath, '{"mcpServers":{"bad":{"env":{"TOKEN":"private-value"}}}}')

    await expect(loadMcpServerConfig('bad', configPath)).rejects.toThrow('configuration "bad" is invalid')
    await expect(loadMcpServerConfig('bad', configPath)).rejects.not.toThrow('private-value')
  })
})
