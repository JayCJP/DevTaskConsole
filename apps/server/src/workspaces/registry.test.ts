import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteWorkspace,
  listWorkspaces,
  WorkspaceNotFoundError,
  WorkspaceRegistryInputError,
} from './registry.js'

let workspacesRoot: string | undefined

afterEach(async () => {
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true })
  workspacesRoot = undefined
})

/**
 * 构造一个最小工作区：.code-workspace 文件 + 若干项目目录。
 * @param root 工作区根目录
 * @returns 工作区目录绝对路径
 */
async function createWorkspaceFixture(root: string): Promise<string> {
  const workspacePath = join(root, 'feature-x')
  await mkdir(join(workspacePath, 'repo-a', '.git'), { recursive: true })
  await writeFile(join(workspacePath, 'repo-a', '.git', 'HEAD'), 'ref: refs/heads/feat/feature-x\n', 'utf8')

  const worktreeGitDir = join(root, 'main-repository', '.git', 'worktrees', 'repo-b')
  await mkdir(worktreeGitDir, { recursive: true })
  await writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feat/feature-x\n', 'utf8')
  await mkdir(join(workspacePath, 'repo-b'), { recursive: true })
  await writeFile(join(workspacePath, 'repo-b', '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8')

  await writeFile(
    join(workspacePath, 'feature-x.code-workspace'),
    JSON.stringify({ folders: [{ path: 'repo-a' }, { path: 'repo-b' }, { path: 'repo-missing' }], settings: {} }),
    'utf8',
  )
  // 工作区根目录下自带 .git 的目录是独立仓库，不应被识别为工作区
  await mkdir(join(root, 'standalone-repository', '.git'), { recursive: true })
  return workspacePath
}

describe('workspace registry listing', () => {
  it('lists workspaces with their worktree projects and branch names', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-registry-'))
    await createWorkspaceFixture(workspacesRoot)

    const workspaces = await listWorkspaces(workspacesRoot)

    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({
      name: 'feature-x',
      missingProjects: ['repo-missing'],
      projects: [
        { name: 'repo-a', worktree: false, branch: 'feat/feature-x' },
        { name: 'repo-b', worktree: true, branch: 'feat/feature-x' },
      ],
    })
  })

  it('reports an unavailable workspaces root instead of returning an empty list', async () => {
    await expect(listWorkspaces(join(tmpdir(), `missing-devtask-workspaces-${Date.now()}`)))
      .rejects.toBeInstanceOf(WorkspaceRegistryInputError)
  })
})

describe('workspace deletion', () => {
  it('removes the workspace directory and reports every project', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-delete-'))
    const workspacePath = await createWorkspaceFixture(workspacesRoot)

    const result = await deleteWorkspace(workspacesRoot, 'feature-x')

    expect(result.removedDirectories).toContain(join(workspacePath, 'repo-a'))
    // git 不可用时回退为目录删除，并记录告警
    expect(result.warnings.join(' ')).toContain('repo-b')
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects path traversal and missing workspaces', async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'devtask-workspace-delete-'))

    await expect(deleteWorkspace(workspacesRoot, '..')).rejects.toBeInstanceOf(WorkspaceRegistryInputError)
    await expect(deleteWorkspace(workspacesRoot, 'not-exist')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
  })
})
