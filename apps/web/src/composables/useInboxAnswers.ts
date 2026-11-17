import { onMounted, ref } from 'vue'
import type { InboxItem } from '@devtask/shared'

/** 单条收件箱答案：文本与最后更新时间（ISO 字符串） */
export interface InboxAnswer {
  /** 用户填写的答案文本 */
  text: string
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string
}

/** localStorage 草稿键前缀，按收件箱事项 ID 隔离 */
const answerKeyPrefix = 'inbox:answer:'

/**
 * 读取本机保存的全部收件箱答案。
 * localStorage 不可用时（隐私模式等）返回空对象，不抛异常。
 * @returns 以事项 ID 为键的答案映射
 */
function readAllAnswers(): Record<string, InboxAnswer> {
  try {
    const result: Record<string, InboxAnswer> = {}
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !key.startsWith(answerKeyPrefix)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) continue
      const record = parsed as Record<string, unknown>
      if (typeof record.text !== 'string' || typeof record.updatedAt !== 'string') continue
      result[key.slice(answerKeyPrefix.length)] = { text: record.text, updatedAt: record.updatedAt }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 把分组后的收件箱事项按渲染顺序摊平，用于汇总编号。
 * 顺序与模板一致：工作区 → Story → 事项。
 * @param groups 已分组的收件箱数据（每组含 stories，每个 story 含 items）
 * @returns 按渲染顺序排列的事项列表
 */
export function flattenInboxGroups<T extends { stories: Array<{ items: InboxItem[] }> }>(groups: T[]): InboxItem[] {
  return groups.flatMap((group) => group.stories.flatMap((story) => story.items))
}

/** 建议稿分段：marker 为圈号（如 ①），text 为该标记后的正文；首段 marker 为空表示没有圈号的引导语 */
export interface SuggestionSegment {
  /** 圈号标记；空字符串表示这段是没有标记的引导语 */
  marker: string
  /** 该段的正文，保留原始换行 */
  text: string
}

/** 建议稿里可能出现的圈号标记，按此切分把一长段文字变成可扫读的编号列表 */
const suggestionMarkers = '①②③④⑤⑥⑦⑧⑨⑩'

/**
 * 把建议稿原文按圈号切成若干段，用于分行展示。
 *
 * 不改写正文，只识别圈号作为视觉分隔：没有圈号时返回单段（marker 为空）；
 * 有圈号时，第一段通常是引导语，其后每段对应一个圈号。换行由 CSS 的 pre-wrap 保留。
 *
 * @param text 建议稿原文
 * @returns 按顺序排列的分段；空文本返回空数组
 */
export function splitSuggestion(text: string): SuggestionSegment[] {
  const clean = text.trim()
  if (!clean) return []
  const parts = clean.split(new RegExp(`([${suggestionMarkers}])`))
  const segments: SuggestionSegment[] = []
  if (parts[0]?.trim()) segments.push({ marker: '', text: parts[0].trim() })
  for (let index = 1; index < parts.length; index += 2) {
    const marker = parts[index] ?? ''
    const body = (parts[index + 1] ?? '').trim()
    segments.push({ marker, text: body })
  }
  return segments
}

/**
 * 把用户填写的答案拼成极简汇总文本，格式为 `Qn:答案`。
 *
 * 只对有答案（去空白后非空）的事项编号，编号从 1 递增；空答案不占位、不产生输出行。
 * 这是纯函数，便于单测：不读 localStorage、不触碰 DOM。
 *
 * @param items 按渲染顺序排列的收件箱事项
 * @param answers 以事项 ID 为键的答案映射
 * @returns 汇总文本，每行一条 `Qn:答案`；无答案时返回空字符串
 */
export function buildInboxAnswerText(items: InboxItem[], answers: Record<string, InboxAnswer>): string {
  const lines: string[] = []
  for (const item of items) {
    const answer = answers[item.id]
    const text = answer?.text.trim() ?? ''
    if (!text) continue
    lines.push(`Q${lines.length + 1}:${text}`)
  }
  return lines.join('\n')
}

/**
 * 收件箱答案的本地草稿管理。
 *
 * 答案只存本机 localStorage，不回写任何上游、不写任何工作区文件。
 * 输入即写盘（防抖 300ms），刷新不丢；清空输入则删除对应草稿。
 * 汇总复制由消费者调用 buildInboxAnswerText 完成，本 composable 只负责数据与落盘。
 *
 * @returns 答案映射、展开事项 ID、设置答案与加载方法
 */
export function useInboxAnswers() {
  /** 以事项 ID 为键的答案映射 */
  const answers = ref<Record<string, InboxAnswer>>({})
  /** 当前展开答案面板的事项 ID；null 表示全部收起 */
  const expandedId = ref<string | null>(null)
  /** 每个事项的防抖定时器：事项 ID → 定时器 */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * 从 localStorage 加载全部答案草稿，进入收件箱页时调用一次。
   */
  function loadAnswers(): void {
    answers.value = readAllAnswers()
  }

  /**
   * 立即把某条答案写入 localStorage（无防抖，供定时器与清理调用）。
   * @param id 收件箱事项 ID
   */
  function writeAnswer(id: string): void {
    const key = `${answerKeyPrefix}${id}`
    const answer = answers.value[id]
    try {
      if (!answer || !answer.text.trim()) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(answer))
      }
    } catch {
      // localStorage 不可用时不阻塞输入；内存中的 answers 仍保留当前值
    }
  }

  /**
   * 设置某条答案：更新内存值并防抖写盘。空文本等价于删除草稿。
   * @param id 收件箱事项 ID
   * @param text 用户输入的答案文本
   */
  function setAnswer(id: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) {
      delete answers.value[id]
    } else {
      answers.value[id] = { text, updatedAt: new Date().toISOString() }
    }
    const pending = debounceTimers.get(id)
    if (pending) clearTimeout(pending)
    debounceTimers.set(id, setTimeout(() => {
      writeAnswer(id)
      debounceTimers.delete(id)
    }, 300))
  }

  /**
   * 切换某条答案面板的展开/收起。
   * @param id 收件箱事项 ID
   */
  function toggleExpanded(id: string): void {
    expandedId.value = expandedId.value === id ? null : id
  }

  /**
   * 卸载前把所有待写盘的草稿立即落盘，避免防抖窗口内刷新丢失。
   */
  function flushPending(): void {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    for (const id of Object.keys(answers.value)) writeAnswer(id)
  }

  onMounted(loadAnswers)

  return { answers, expandedId, loadAnswers, setAnswer, toggleExpanded, flushPending }
}
