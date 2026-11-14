import { describe, expect, it } from 'vitest'
import {
  cronPresets,
  describeCron,
  forbiddenMinutesOf,
  matchesPreset,
  nextCronRuns,
  parseCron,
  validateCronExpression,
} from '@devtask/shared'

describe('cron-rule', () => {
  it('解析 5 字段表达式并展开步长', () => {
    const parsed = parseCron('5,25,45 * * * *')
    expect(parsed?.minutes).toEqual([5, 25, 45])
    expect(parsed?.hours).toHaveLength(24)
  })

  it('拒绝字段数量或取值非法的表达式', () => {
    expect(parseCron('* * * *')).toBeUndefined()
    expect(parseCron('60 * * * *')).toBeUndefined()
    expect(parseCron('* 24 * * *')).toBeUndefined()
    expect(parseCron('a * * * *')).toBeUndefined()
    expect(validateCronExpression('* * * * *').ok).toBe(false)
  })

  it('所有预设都避开 0 分与 30 分', () => {
    expect(cronPresets.map((preset) => preset.id)).toEqual([
      'every-20m',
      'every-30m',
      'every-60m',
      'every-4h',
      'every-6h',
      'every-8h',
    ])
    for (const preset of cronPresets) {
      expect(validateCronExpression(preset.expression).ok).toBe(true)
      expect(forbiddenMinutesOf(preset.expression)).toEqual([])
      expect(matchesPreset(preset.expression, preset)).toBe(true)
    }
  })

  it('小时级预设每天按 4、6、8 小时间隔运行', () => {
    const expectedHours: Record<string, number[]> = {
      'every-4h': [0, 4, 8, 12, 16, 20],
      'every-6h': [0, 6, 12, 18],
      'every-8h': [0, 8, 16],
    }
    for (const [id, hours] of Object.entries(expectedHours)) {
      const preset = cronPresets.find((item) => item.id === id)
      expect(preset).toBeDefined()
      expect(parseCron(preset?.expression ?? '')?.hours).toEqual(hours)
      expect(parseCron(preset?.expression ?? '')?.minutes).toEqual([7])
    }
  })

  it('命中 0 分或 30 分时给出可读原因', () => {
    expect(forbiddenMinutesOf('*/20 * * * *')).toEqual([0, 20, 40].filter((minute) => minute === 0 || minute === 30))
    const result = validateCronExpression('0,30 9-18 * * 1-5')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('0 或 30')
  })

  it('计算后续运行时间且不重复命中', () => {
    const from = new Date('2026-11-14T10:00:00')
    const runs = nextCronRuns('15,45 * * * *', from, 3)
    expect(runs.map((run) => run.getMinutes())).toEqual([15, 45, 15])
    expect(runs[0]?.getTime()).toBeLessThan(runs[1]?.getTime() ?? 0)
  })

  it('对不可能命中的表达式返回空数组而不是死循环', () => {
    expect(nextCronRuns('15 5 30 2 *', new Date('2026-11-14T10:00:00'), 2).length).toBeLessThanOrEqual(2)
  })

  it('生成中文描述', () => {
    expect(describeCron('15 * * * *')).toBe('每 60 分钟')
    expect(describeCron('15 9 * * *')).toBe('每天 9 时 15 分')
    expect(describeCron('bad')).toBe('表达式无效')
  })
})
