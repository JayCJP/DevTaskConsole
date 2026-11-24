import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InboxItem } from '@devtask/shared'
import {
  boldPartsOf,
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

/** 构造一条带真实问题编号的 open_question 事项（id 格式同 buildInbox 输出） */
function makeQuestionItem(questionId: string): InboxItem {
  return makeItem(`question:STORY-1:${questionId}`)
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

  it('open_question 使用真实问题编号（如 Q-12），而非顺序编号', () => {
    const questionItems = [
      makeQuestionItem('Q-12'),
      makeQuestionItem('Q-13'),
      makeQuestionItem('Q-14'),
      makeQuestionItem('Q-15'),
    ]
    const answers: Record<string, InboxAnswer> = {
      [questionItems[0].id]: { text: '答十二', updatedAt: 't' },
      [questionItems[2].id]: { text: '答十四', updatedAt: 't' },
      [questionItems[3].id]: { text: '答十五', updatedAt: 't' },
    }
    expect(buildInboxAnswerText(questionItems, answers)).toBe(
      'Q-12:答十二\nQ-14:答十四\nQ-15:答十五',
    )
  })

  it('真实编号与顺序编号混用时各自取正确标号', () => {
    const mixed = [makeQuestionItem('Q-12'), makeItem('blocked:STORY-1')]
    mixed[1] = { ...mixed[1], kind: 'blocked_job' }
    const answers: Record<string, InboxAnswer> = {
      [mixed[0].id]: { text: 'A', updatedAt: 't' },
      [mixed[1].id]: { text: 'B', updatedAt: 't' },
    }
    expect(buildInboxAnswerText(mixed, answers)).toBe('Q-12:A\nQ2:B')
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

  it('按括号数字 (1)(2) 切分，marker 为完整括号编号', () => {
    const segments = splitSuggestion('建议如下：(1) 第一条；(2) 第二条。')
    expect(segments.map((s) => s.marker)).toEqual(['', '(1)', '(2)'])
    expect(segments.map((s) => s.text)).toEqual(['建议如下：', '第一条；', '第二条。'])
  })

  it('兼容全角括号编号 （1）', () => {
    const segments = splitSuggestion('（1）第一条（2）第二条')
    expect(segments.map((s) => s.marker)).toEqual(['（1）', '（2）'])
    expect(segments.map((s) => s.text)).toEqual(['第一条', '第二条'])
  })

  it('「理由：」「不确定点：」不拆段，保留在同一段正文里', () => {
    const segments = splitSuggestion(
      '建议：(1) 接入；(2) 恢复入口。理由：语义不同。不确定点：待确认。',
    )
    expect(segments.map((s) => s.marker)).toEqual(['', '(1)', '(2)'])
    expect(segments[2].text).toBe('恢复入口。理由：语义不同。不确定点：待确认。')
  })

  it('空文本返回空数组', () => {
    expect(splitSuggestion('')).toEqual([])
    expect(splitSuggestion('   ')).toEqual([])
  })
})

describe('boldPartsOf', () => {
  it('无关键字眼时原样返回单段，不标记加粗', () => {
    expect(boldPartsOf('普通正文')).toEqual([{ text: '普通正文', bold: false }])
  })

  it('把「理由：」「不确定点：」连同冒号拆为加粗片段', () => {
    expect(boldPartsOf('前文。理由：语义不同。不确定点：待确认。')).toEqual([
      { text: '前文。', bold: false },
      { text: '理由：', bold: true },
      { text: '语义不同。', bold: false },
      { text: '不确定点：', bold: true },
      { text: '待确认。', bold: false },
    ])
  })

  it('句中出现的关键字眼也能加粗，不要求段首', () => {
    expect(boldPartsOf('这里说明：语义不同。')).toEqual([
      { text: '这里', bold: false },
      { text: '说明：', bold: true },
      { text: '语义不同。', bold: false },
    ])
  })

  it('空文本返回空数组', () => {
    expect(boldPartsOf('')).toEqual([])
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
