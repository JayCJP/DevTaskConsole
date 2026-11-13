import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GitLabAdapter } from './gitlab.js'

let server: Server | undefined
let tempDirectory: string | undefined
const previousConfigPath = process.env.DEVTASK_MCP_CONFIG

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()))
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  if (previousConfigPath === undefined) delete process.env.DEVTASK_MCP_CONFIG
  else process.env.DEVTASK_MCP_CONFIG = previousConfigPath
  server = undefined
  tempDirectory = undefined
})

describe('GitLab read adapter', () => {
  it('uses the configured API prefix and returns merge requests by source branch', async () => {
    let requestPath = ''
    let tokenHeader = ''
    server = createServer((request, response) => {
      requestPath = request.url ?? ''
      const receivedHeader = request.headers['private-token']
      tokenHeader = Array.isArray(receivedHeader) ? receivedHeader[0] ?? '' : receivedHeader ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{
        id: 71,
        iid: 9,
        title: 'Update login flow',
        source_branch: 'feat/workspace-a',
        target_branch: 'dev',
        state: 'opened',
        detailed_merge_status: 'mergeable',
        web_url: 'https://gitlab.example/group/repo/-/merge_requests/9',
      }]))
    })
    await listen(server)
    await configureServer(server)

    const adapter = new GitLabAdapter()
    const mergeRequests = await adapter.listMergeRequests(12, 'feat/workspace-a')

    expect(requestPath).toBe('/api/v4/projects/12/merge_requests?source_branch=feat%2Fworkspace-a&state=all&per_page=100')
    expect(tokenHeader).toBe('test-token')
    expect(mergeRequests).toEqual([{
      projectId: 12,
      id: '9',
      title: 'Update login flow',
      sourceBranch: 'feat/workspace-a',
      targetBranch: 'dev',
      state: 'opened',
      mergeStatus: 'mergeable',
      webUrl: 'https://gitlab.example/group/repo/-/merge_requests/9',
    }])
  })

  it('surfaces HTTP failures without including configured credentials', async () => {
    server = createServer((_request, response) => {
      response.writeHead(403)
      response.end('test-token')
    })
    await listen(server)
    await configureServer(server)

    await expect(new GitLabAdapter().checkConnection()).rejects.toThrow('HTTP 403')
    await expect(new GitLabAdapter().checkConnection()).rejects.not.toThrow('test-token')
  })

  it('loads merge request approvals and changed-file metadata', async () => {
    const requestPaths: string[] = []
    server = createServer((request, response) => {
      requestPaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url?.endsWith('/approvals')) {
        response.end(JSON.stringify({
          approved: true,
          approved_by: [{ user: { name: 'Reviewer' } }],
        }))
      } else if (request.url?.endsWith('/changes')) {
        response.end(JSON.stringify({ changes: [{ old_path: 'old.ts', new_path: 'new.ts' }] }))
      } else {
        response.end(JSON.stringify({ changes_count: '1' }))
      }
    })
    await listen(server)
    await configureServer(server)

    const details = await new GitLabAdapter().getMergeRequestDetails(12, '9')

    expect(requestPaths).toHaveLength(3)
    expect(details).toEqual({
      approvals: { approved: true, approvedBy: ['Reviewer'] },
      changesCount: 1,
      changedFiles: ['old.ts → new.ts'],
    })
  })
})

async function configureServer(target: Server): Promise<void> {
  const address = target.address() as AddressInfo
  tempDirectory = await mkdtemp(join(tmpdir(), 'devtask-gitlab-'))
  const configPath = join(tempDirectory, 'mcp.json')
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      GitLab: {
        command: 'npx',
        env: {
          GITLAB_API_URL: `http://127.0.0.1:${address.port}/api/v4`,
          GITLAB_PERSONAL_ACCESS_TOKEN: 'test-token',
        },
      },
    },
  }))
  process.env.DEVTASK_MCP_CONFIG = configPath
}

async function listen(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
}
