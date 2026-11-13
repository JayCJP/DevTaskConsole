import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RepositoryCandidate {
  name: string
  path: string
}

export function getSourceRoot(): string {
  if (process.env.DEVTASK_SOURCE_ROOT) return process.env.DEVTASK_SOURCE_ROOT
  return process.platform === 'win32' ? 'D:\\workfile' : join(homedir(), 'devtask-repositories')
}

export async function listRepositoryCandidates(sourceRoot = getSourceRoot()): Promise<RepositoryCandidate[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const candidates: RepositoryCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const repositoryPath = join(sourceRoot, entry.name)
    try {
      await access(join(repositoryPath, '.git'))
      candidates.push({ name: entry.name, path: repositoryPath })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
