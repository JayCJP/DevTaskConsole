import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applicationMappingSchema, type ApplicationMapping } from '@devtask/shared'
import { getDataDirectory } from '../security/token-store.js'

export class ApplicationMappingStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDirectory = getDataDirectory()) {
    this.filePath = join(dataDirectory, 'application-mappings.json')
  }

  async list(): Promise<ApplicationMapping[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error('Application mapping file contains invalid JSON.', { cause: error })
    }
    const parsed = applicationMappingSchema.array().safeParse(value)
    if (!parsed.success) throw new Error('Application mapping file has an invalid shape.', { cause: parsed.error })
    ensureUniqueRepositories(parsed.data)
    return parsed.data
  }

  async upsert(input: unknown): Promise<ApplicationMapping[]> {
    const parsed = applicationMappingSchema.safeParse(input)
    if (!parsed.success) throw new Error('Application mapping parameters are invalid.')
    return this.serialize(async () => {
      const current = await this.list()
      const next = [
        ...current.filter((mapping) => mapping.repoName !== parsed.data.repoName),
        parsed.data,
      ].sort((left, right) => left.repoName.localeCompare(right.repoName))
      await this.write(next)
      return next
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async write(mappings: ApplicationMapping[]): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(mappings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }
}

function ensureUniqueRepositories(mappings: ApplicationMapping[]): void {
  const seen = new Set<string>()
  for (const mapping of mappings) {
    if (seen.has(mapping.repoName)) throw new Error('Application mapping file contains duplicate repository names.')
    seen.add(mapping.repoName)
  }
}
