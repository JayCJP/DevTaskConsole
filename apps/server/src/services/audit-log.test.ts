import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog, isReversibleAction } from './audit-log.js'

let dataDirectory: string | undefined

afterEach(async () => {
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
  dataDirectory = undefined
})

/**
 * 创建临时数据目录。
 * @returns 目录路径
 */
async function createDirectory(): Promise<string> {
  dataDirectory = await mkdtemp(join(tmpdir(), 'devtask-audit-'))
  return dataDirectory
}

describe('AuditLog', () => {
  it('按写入顺序保存条目并可倒序读取', async () => {
    const directory = await createDirectory()
    const log = new AuditLog(directory)
    await log.record({ action: 'cron.update', target: 'task-1', storyId: 'STORY-1', before: { cron: '1 * * * *' } })
    await log.record({ action: 'cron.delete', target: 'task-1', reversible: false })

    const entries = await log.list()
    expect(entries.map((entry) => entry.action)).toEqual(['cron.delete', 'cron.update'])
    expect(entries[1]?.before).toEqual({ cron: '1 * * * *' })
    // 可撤销性由动作白名单推导，删除类动作强制不可撤销
    expect(entries[1]?.reversible).toBe(true)
    expect(entries[0]?.reversible).toBe(false)
  })

  it('支持原子占用撤销，且只能占用一次', async () => {
    const directory = await createDirectory()
    const log = new AuditLog(directory)
    const entry = await log.record({ action: 'cron.toggle', target: 'task-1' })

    const undone = await log.claimUndo(entry.id)
    expect(undone?.undone).toBe(true)
    expect(undone?.undoneAt).toBeDefined()
    expect((await log.find(entry.id))?.undone).toBe(true)
    expect(await log.claimUndo(entry.id)).toBeNull()
    expect(await log.claimUndo('missing')).toBeUndefined()
  })

  it('并发占用同一条目只有一个成功', async () => {
    const directory = await createDirectory()
    const log = new AuditLog(directory)
    const entry = await log.record({ action: 'cron.owner', target: 'task-1' })
    const results = await Promise.all([log.claimUndo(entry.id), log.claimUndo(entry.id)])
    expect(results.filter((result) => result !== null && result !== undefined)).toHaveLength(1)
    expect(results.filter((result) => result === null)).toHaveLength(1)
  })

  it('释放占用后可再次撤销，并记录失败原因', async () => {
    const directory = await createDirectory()
    const log = new AuditLog(directory)
    const entry = await log.record({ action: 'cron.update', target: 'task-1' })
    await log.claimUndo(entry.id)
    const released = await log.releaseUndo(entry.id, '上游超时')
    expect(released).toMatchObject({ undone: false, error: '上游超时' })
    expect(released?.undoneAt).toBeUndefined()
    await expect(log.claimUndo(entry.id)).resolves.toMatchObject({ undone: true })
  })

  it('条数超过上限时丢弃最旧记录', async () => {
    const directory = await createDirectory()
    const log = new AuditLog(directory, 20)
    for (let index = 0; index < 25; index += 1) {
      await log.record({ action: 'cron.renew', target: `task-${index}` })
    }
    const entries = await log.list(100)
    expect(entries).toHaveLength(20)
    expect(entries[0]?.target).toBe('task-24')
    expect(entries.at(-1)?.target).toBe('task-5')
    // 上限同时约束落盘内容，避免文件无限增长
    const persisted = JSON.parse(await readFile(join(directory, 'audit-log.json'), 'utf8')) as unknown[]
    expect(persisted).toHaveLength(20)
  })

  it('丢弃结构非法的历史记录而不是整体失败', async () => {
    const directory = await createDirectory()
    await writeFile(
      join(directory, 'audit-log.json'),
      JSON.stringify([
        { id: 'a', action: 'unknown.action', target: 'task-1', reversible: true, undone: false, result: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', action: 'cron.update', target: 'task-2', reversible: true, undone: false, result: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    )
    const log = new AuditLog(directory)
    expect((await log.list()).map((entry) => entry.id)).toEqual(['b'])
  })

  it('非法 JSON 直接报错，避免静默丢审计', async () => {
    const directory = await createDirectory()
    await writeFile(join(directory, 'audit-log.json'), '{')
    await expect(new AuditLog(directory).list()).rejects.toThrow('invalid JSON')
  })

  it('可撤销白名单只包含映射与启停类动作', () => {
    expect(isReversibleAction('cron.update')).toBe(true)
    expect(isReversibleAction('cron.toggle')).toBe(true)
    expect(isReversibleAction('cron.owner')).toBe(true)
    expect(isReversibleAction('cron.delete')).toBe(false)
    expect(isReversibleAction('service.stop')).toBe(false)
    expect(isReversibleAction('cron.executions.delete')).toBe(false)
  })
})
