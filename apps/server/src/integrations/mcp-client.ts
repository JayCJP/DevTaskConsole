import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadMcpServerConfig } from './mcp-config.js'

export class McpClientRegistry {
  private readonly clients = new Map<string, Promise<Client | null>>()

  async listTools(serverName: string) {
    const client = await this.getClient(serverName)
    if (!client) return null
    return client.listTools()
  }

  async callTool(serverName: string, name: string, args: Record<string, unknown>) {
    const client = await this.getClient(serverName)
    if (!client) return null
    return client.callTool({ name, arguments: args })
  }

  async close(): Promise<void> {
    const connections = await Promise.allSettled(this.clients.values())
    this.clients.clear()
    await Promise.all(connections.flatMap((connection) =>
      connection.status === 'fulfilled' && connection.value
        ? [connection.value.close()]
        : [],
    ))
  }

  private async getClient(serverName: string): Promise<Client | null> {
    let pending = this.clients.get(serverName)
    if (!pending) {
      pending = this.connect(serverName)
      this.clients.set(serverName, pending)
      void pending.catch(() => {
        if (this.clients.get(serverName) === pending) this.clients.delete(serverName)
      })
    }
    const client = await pending
    if (!client && this.clients.get(serverName) === pending) this.clients.delete(serverName)
    return client
  }

  private async connect(serverName: string): Promise<Client | null> {
    const config = await loadMcpServerConfig(serverName)
    if (!config) return null

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
    })
    const client = new Client({ name: 'devtask-console', version: '0.1.0' })
    try {
      await client.connect(transport)
      return client
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
  }
}

export const mcpClientRegistry = new McpClientRegistry()
