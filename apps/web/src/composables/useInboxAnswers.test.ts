import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InboxItem } from '@devtask/shared'
import {
  buildInboxAnswerText,
  flattenInboxGroups,
  splitSuggestion,
  useInboxAnswers,
  type InboxAnswer,
} from './useInboxAnswers'

/** 构造一条最小收件箱事项，仅测试所需字段 */
function makeItem(id: string): InboxItem {
  return {
    id,
    kind: 'open_question',
    title: `问题 ${id}`,
    reason: '原因',
    priority: 'normal',
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('flattenInboxGroups', () => {
  it('按工作区 → Story → 事项顺序摊平', () => {
    const groups = [
      { stories: [{ items: [makeItem('a'), makeItem('b')] }] },
      { stories: [{ items: [makeItem('c')] }, { items: [makeItem('d')] }] },
    ]
    expect(flattenInboxGroups(groups).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('buildInboxAnswerText', () => {
  const items = [makeItem('a'), makeItem('b'), makeItem('c')]

  it('只为有答案的事项编号，格式为 Qn:答案', () => {
    const answers: Record<string, InboxAnswer> = {
      a: { text: '第一个答案', updatedAt: '2026-01-01T00:00:00Z' },
      c: { text: '第二个答案', updatedAt: '2026-01-01T00:00:00Z' },
    }
    expect(buildInboxAnswerText(items, answers)).toBe('Q1:第一个答案\nQ2:第二个答案')
  })

  it('跳过空答案与纯空白答案，且编号连续', () => {
    const answers: Record<string, InboxAnswer> = {
      a: { text: '   ', updatedAt: '2026-01-01T00:00:00Z' },
      b: { text: '保留这个', updatedAt: '2026-01-01T00:00:00Z' },
    }
    expect(buildInboxAnswerText(items, answers)).toBe('Q1:保留这个')
  })

  it('没有答案时返回空字符串', () => {
    expect(buildInboxAnswerText(items, {})).toBe('')
    expect(buildInboxAnswerText([], { a: { text: 'x', updatedAt: 't' } })).toBe('')
  })

  it('按 items 顺序编号，与 answers 键顺序无关', () => {
    const answers: Record<string, InboxAnswer> = {
      c: { text: 'C', updatedAt: 't' },
      a: { text: 'A', updatedAt: 't' },
    }
    expect(buildInboxAnswerText(items, answers)).toBe('Q1:A\nQ2:C')
  })
})

describe('splitSuggestion', () => {
  it('无圈号时返回单段引导语，不丢失正文', () => {
    expect(splitSuggestion('  按现有范式实现  ')).toEqual([{ marker: '', text: '按现有范式实现' }])
  })

  it('按圈号切分，保留引导语与每条正文', () => {
    const segments = splitSuggestion('建议如下：① 第一条；② 第二条；③ 第三条。')
    expect(segments.map((s) => s.marker)).toEqual(['', '①', '②', '③'])
    expect(segments.map((s) => s.text)).toEqual(['建议如下：', '第一条；', '第二条；', '第三条。'])
  })

  it('保留正文里的原始换行', () => {
    const segments = splitSuggestion('① 首行\n次行；② 另一条')
    expect(segments[0]).toEqual({ marker: '①', text: '首行\n次行；' })
    expect(segments[1]).toEqual({ marker: '②', text: '另一条' })
  })

  it('空文本返回空数组', () => {
    expect(splitSuggestion('')).toEqual([])
    expect(splitSuggestion('   ')).toEqual([])
  })
})

describe('useInboxAnswers 本地草稿', () => {
  it('setAnswer 更新内存值，空文本删除草稿', () => {
    vi.stubGlobal('localStorage', {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    const { setAnswer, answers, flushPending } = useInboxAnswers()
    setAnswer('a', '  内容  ')
    expect(answers.value.a.text).toBe('  内容  ')
    setAnswer('a', '  ')
    expect(answers.value.a).toBeUndefined()
    flushPending()
  })

  it('loadAnswers 从 localStorage 读取既有草稿', () => {
    const stored = { text: '已有的答案', updatedAt: '2026-01-01T00:00:00Z' }
    vi.stubGlobal('localStorage', {
      length: 1,
      key: (index: number) => (index === 0 ? 'inbox:answer:x' : null),
      getItem: (key: string) => (key === 'inbox:answer:x' ? JSON.stringify(stored) : null),
      setItem: () => {},
      removeItem: () => {},
    })
    const { answers, loadAnswers } = useInboxAnswers()
    loadAnswers()
    expect(answers.value.x).toEqual(stored)
  })
})
