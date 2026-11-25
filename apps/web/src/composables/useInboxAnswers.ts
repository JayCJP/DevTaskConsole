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
export function flattenInboxGroups<T extends { stories: Array<{ items: InboxItem[] }> }>(
  groups: T[],
): InboxItem[] {
  return groups.flatMap((group) => group.stories.flatMap((story) => story.items))
}

/** 建议稿分段：marker 为编号标记（如 ① 或 (1)），text 为该标记后的正文；首段 marker 为空表示没有编号的引导语 */
export interface SuggestionSegment {
  /** 编号标记；空字符串表示这段是没有编号的引导语 */
  marker: string
  /** 该段的正文，保留原始换行 */
  text: string
}

/** 正文里需要加粗的字眼片段：bold 为 true 时加粗渲染 */
export interface EmphasisPart {
  /** 片段文字 */
  text: string
  /** 是否加粗 */
  bold: boolean
}

/** 建议稿里可能出现的圈号标记，按此切分把一长段文字变成可扫读的编号列表 */
const circleMarkers = '①②③④⑤⑥⑦⑧⑨⑩'

/** 括号数字编号，兼容半角 (1) 与全角 （1）；作为整体捕获，避免只抓到单个括号 */
const parenMarkerPattern = '[（(]\\d+[)）]'

/** 编号标记统一匹配：圈号单个字符，或括号数字整体；用捕获组保留分隔符 */
const markerPattern = new RegExp(`((?:[${circleMarkers}]|${parenMarkerPattern}))`)

/** 正文中需要 inline 加粗的字眼（不含冒号），连同冒号一起高亮 */
const boldWords = ['理由', '不确定点', '说明', '注意', '备注', '依据', '风险', '背景']

/** 加粗字眼匹配：词 + 可选冒号，供 split 保留分隔符 */
const boldWordPattern = new RegExp(`((?:${boldWords.join('|')})[:：]?)`, 'g')

/**
 * 把建议稿原文按编号切成若干段，用于分行展示。
 *
 * 不改写正文，只识别编号作为视觉分隔：圈号（①…⑩）与括号数字（(1)/（1)）均支持；
 * 没有编号时返回单段（marker 为空）；有编号时，第一段通常是引导语，其后每段对应一个编号。
 * 「理由：」「不确定点：」等字眼不作为分隔，保留在正文内，由 boldPartsOf 负责加粗。
 * 换行由 CSS 的 pre-wrap 保留。
 *
 * @param text 建议稿原文
 * @returns 按顺序排列的分段；空文本返回空数组
 */
export function splitSuggestion(text: string): SuggestionSegment[] {
  const clean = text.trim()
  if (!clean) return []

  const parts = clean.split(markerPattern)
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
 * 把正文按需要加粗的字眼拆成片段，供模板 inline 渲染加粗。
 *
 * 只拆分「理由：」「不确定点：」等字眼（连同冒号），其余文字原样保留；
 * 字眼出现在句中任意位置均可加粗，不要求位于段首。这是纯函数，便于单测。
 *
 * @param text 正文原文
 * @returns 按顺序排列的片段，bold 为 true 的片段需加粗渲染
 */
export function boldPartsOf(text: string): EmphasisPart[] {
  if (!text) return []
  const parts = text.split(boldWordPattern)
  return parts
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      bold: boldWords.some(
        (word) => part === word || part.startsWith(word + '：') || part.startsWith(word + ':'),
      ),
    }))
}

/** 汇总答复末尾附加的后续处理提示，与答案行之间空一行 */
const answerFollowUpHint =
  '根据答复再次分析，没问题请同步更新需求文档。如需调整AC请根据实际情况调整，如有调整给出变动的项'

/**
 * 从收件箱事项中提取 open question 的真实编号。
 *
 * 后端把待确认项编码成 `question:<storyId>:<questionId>`（见 snapshot.ts 的 buildInbox），
 * 其中 questionId 即 open-questions.json 里的真实 ID（如 `Q-12`）。
 * 仅当格式严格匹配三段式且 questionId 非空时才返回，否则返回空串表示无真实编号。
 *
 * @param item 收件箱事项
 * @returns 真实问题编号；非 open_question 或格式不符时返回空字符串
 */
function realQuestionIdOf(item: InboxItem): string {
  if (item.kind !== 'open_question') return ''
  const parts = item.id.split(':')
  if (parts.length !== 3 || parts[0] !== 'question') return ''
  return parts[2]?.trim() ? parts[2] : ''
}

/**
 * 把用户填写的答案拼成极简汇总文本，格式为 `<编号>:答案`。
 *
 * open_question 事项使用 open-questions.json 里的真实编号（如 `Q-12:答案`），
 * 与看板「需求待确认项」保持一致；无法取得真实编号的事项（如 blocked_job、
 * 非标准 ID）才回退到按已填答案顺序从 Q1 递增。空答案不占位、不产生输出行。
 * 末尾空一行后附加后续处理提示（见 answerFollowUpHint）。
 * 这是纯函数，便于单测：不读 localStorage、不触碰 DOM。
 *
 * @param items 按渲染顺序排列的收件箱事项
 * @param answers 以事项 ID 为键的答案映射
 * @returns 汇总文本，每行一条 `<编号>:答案` 加末尾提示；无答案时返回空字符串
 */
export function buildInboxAnswerText(
  items: InboxItem[],
  answers: Record<string, InboxAnswer>,
): string {
  const lines: string[] = []
  for (const item of items) {
    const answer = answers[item.id]
    const text = answer?.text.trim() ?? ''
    if (!text) continue
    const label = realQuestionIdOf(item) || `Q${lines.length + 1}`
    lines.push(`${label}:${text}`)
  }
  if (!lines.length) return ''
  return `${lines.join('\n')}\n\n${answerFollowUpHint}`
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
    debounceTimers.set(
      id,
      setTimeout(() => {
        writeAnswer(id)
        debounceTimers.delete(id)
      }, 300),
    )
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
