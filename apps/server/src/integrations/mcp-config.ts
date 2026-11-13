import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const serverConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
})

export type McpServerConfig = z.infer<typeof serverConfigSchema>

export function getMcpConfigPath(): string {
  return process.env.DEVTASK_MCP_CONFIG ?? join(homedir(), '.codebuddy', 'mcp.json')
}

export async function loadMcpServerConfig(
  name: string,
  configPath = getMcpConfigPath(),
): Promise<McpServerConfig | null> {
  let contents: string
  try {
    contents = await readFile(configPath, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }

  let config: unknown
  try {
    config = JSON.parse(contents)
  } catch {
    throw new Error('The MCP configuration file is not valid JSON.')
  }

  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    throw new Error('The MCP configuration file must contain an mcpServers object.')
  }
  const entry = config.mcpServers[name]
  if (entry === undefined) return null

  const parsed = serverConfigSchema.safeParse(entry)
  if (!parsed.success) {
    throw new Error(`The MCP server configuration "${name}" is invalid.`)
  }
  return parsed.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
