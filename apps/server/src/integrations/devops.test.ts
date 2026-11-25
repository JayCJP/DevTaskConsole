import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevOpsAdapter } from './devops.js'

let server: Server | undefined
let tempDirectory: string | undefined
const previousConfigPath = process.env.DEVTASK_MCP_CONFIG

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    )
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  if (previousConfigPath === undefined) delete process.env.DEVTASK_MCP_CONFIG
  else process.env.DEVTASK_MCP_CONFIG = previousConfigPath
  server = undefined
  tempDirectory = undefined
})

describe('DevOps read adapter', () => {
  it('maps branch names, commits and last commit timestamps', async () => {
    let requestPath = ''
    server = createServer((request, response) => {
      requestPath = request.url ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          data: [
            {
              name: 'origin/dev',
              commit_id: 'abc123',
              last_commit_time: '2026-03-20T10:00:00Z',
            },
          ],
        }),
      )
    })
    await listen(server)
    await configureServer(server)

    const branches = await new DevOpsAdapter().getBranches('Console Web', 'JenkinsFrontweb')

    expect(requestPath).toBe('/deploy/branch?app=Console+Web')
    expect(branches).toEqual([
      {
        app: 'Console Web',
        group: 'JenkinsFrontweb',
        name: 'origin/dev',
        commitId: 'abc123',
        lastCommitTime: '2026-03-20T10:00:00.000Z',
      },
    ])
  })

  it('sends the session headers and maps build records from the documented response shape', async () => {
    let requestPath = ''
    let cookieHeader = ''
    let csrfHeader = ''
    server = createServer((request, response) => {
      requestPath = request.url ?? ''
      cookieHeader = request.headers.cookie ?? ''
      csrfHeader = String(request.headers['x-csrftoken'] ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          detail: [
            {
              id: 4,
              number: 'build-104',
              alias: 'Console Web',
              branch: 'origin/dev_feature',
              commit_id: 'abc123',
              build_date: '2026-03-20T10:00:00Z',
              duration_time: '48',
              last_name: 'dev-user',
              succeed: 1,
              file_url: 'https://artifacts.example/build.zip',
            },
          ],
          total: 1,
        }),
      )
    })
    await listen(server)
    await configureServer(server)

    const builds = await new DevOpsAdapter().getBuildRecords('Console Web', 2, 20)

    expect(requestPath).toBe('/deploy/build?app=Console+Web&page_no=2&page_size=20')
    expect(cookieHeader).toBe(
      'login_id=login; user=dev; csrftoken=csrf; sessionid=private-session-token',
    )
    expect(csrfHeader).toBe('csrf')
    expect(builds).toEqual([
      {
        id: '4',
        app: 'Console Web',
        number: 'build-104',
        branch: 'origin/dev_feature',
        commitId: 'abc123',
        succeed: true,
        buildDate: '2026-03-20T10:00:00.000Z',
        durationTime: 48,
        operator: 'dev-user',
        fileUrl: 'https://artifacts.example/build.zip',
      },
    ])
  })

  it('exposes the configured login account for build operator matching', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await listen(server)
    await configureServer(server)

    await expect(new DevOpsAdapter().getLoginUser()).resolves.toBe('dev')
  })

  it('returns null when DevOps is not configured', async () => {
    process.env.DEVTASK_MCP_CONFIG = join(tmpdir(), 'devtask-missing-mcp.json')

    await expect(new DevOpsAdapter().getLoginUser()).resolves.toBeNull()
  })

  it('surfaces expired sessions without returning credential values', async () => {
    server = createServer((_request, response) => {
      response.writeHead(403)
      response.end('session')
    })
    await listen(server)
    await configureServer(server)

    await expect(new DevOpsAdapter().checkConnection()).rejects.toThrow(
      'session expired (HTTP 403)',
    )
    await expect(new DevOpsAdapter().checkConnection()).rejects.not.toThrow('private-session-token')
  })

  it('reports deployment and environment facts as unknown instead of guessing', () => {
    const facts = new DevOpsAdapter().getReleaseFacts('repo-one')
    expect(facts.deployment.fact).toBe('unknown')
    expect(facts.deployment.statement).toContain('构建成功不等于已部署')
    expect(facts.deployment.statement).toContain('repo-one')
    expect(facts.environment.fact).toBe('unknown')
    expect(facts.environment.statement).toContain('dev 与 test')
  })

  it('posts batch deploy urls and env to the documented endpoint', async () => {
    let requestPath = ''
    let method = ''
    let body: Record<string, unknown> = {}
    server = createServer((request, response) => {
      requestPath = request.url ?? ''
      method = request.method ?? ''
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ taskId: 'deploy-1' }))
      })
    })
    await listen(server)
    await configureServer(server)

    const result = await new DevOpsAdapter().deployMultiple({
      urls: ['https://artifacts.example/a.zip', 'https://artifacts.example/b.zip'],
      env: 'pre-txnj',
    })

    expect(requestPath).toBe('/deploy/deploy_multiple')
    expect(method).toBe('POST')
    expect(body).toEqual({
      // DevOps 接口要求 urls 为换行分隔的字符串，而非数组（见 mcp-server.js 的 join('\n') 口径）
      urls: 'https://artifacts.example/a.zip\nhttps://artifacts.example/b.zip',
      env: 'pre-txnj',
      force: '0',
      timeout: 300,
    })
    expect(result).toEqual({ taskId: 'deploy-1' })
  })

  it('surfaces expired sessions on batch deploy without leaking credentials', async () => {
    server = createServer((_request, response) => {
      response.writeHead(403)
      response.end('session')
    })
    await listen(server)
    await configureServer(server)

    await expect(
      new DevOpsAdapter().deployMultiple({ urls: ['https://artifacts.example/a.zip'], env: 'dev' }),
    ).rejects.toThrow('session expired (HTTP 403)')
  })
})

async function configureServer(target: Server): Promise<void> {
  const address = target.address() as AddressInfo
  tempDirectory = await mkdtemp(join(tmpdir(), 'devtask-devops-'))
  const configPath = join(tempDirectory, 'mcp.json')
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        Devops_MCP: {
          command: 'npx',
          env: {
            HOST: `http://127.0.0.1:${address.port}`,
            login_id: 'login',
            user: 'dev',
            csrftoken: 'csrf',
            sessionid: 'private-session-token',
          },
        },
      },
    }),
  )
  process.env.DEVTASK_MCP_CONFIG = configPath
}

async function listen(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
}
