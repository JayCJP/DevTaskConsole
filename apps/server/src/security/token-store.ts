import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function getDataDirectory(): string {
  const baseDirectory = process.env.LOCALAPPDATA || homedir()
  return process.env.DEVTASK_DATA_DIR || join(baseDirectory, 'DevTaskConsole')
}

export async function loadOrCreateToken(dataDirectory = getDataDirectory()): Promise<string> {
  await mkdir(dataDirectory, { recursive: true })
  const tokenPath = join(dataDirectory, 'control-panel-token')

  try {
    const storedToken = (await readFile(tokenPath, 'utf8')).trim()
    if (storedToken.length === 0) {
      throw new Error(`Stored control-panel token is invalid: ${tokenPath}`)
    }
    return storedToken
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw error
    }
  }

  const newToken = randomBytes(32).toString('hex')
  try {
    await writeFile(tokenPath, `${newToken}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return newToken
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) {
      throw error
    }
    return loadOrCreateToken(dataDirectory)
  }
}

export function tokenMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
