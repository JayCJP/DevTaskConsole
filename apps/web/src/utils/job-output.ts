/**
 * Job 实时输出（SSE 原始流）解析工具。
 * 只保留「用户输入」与「助手输出」两类消息，其余（工具调用/结果、keepalive、
 * session-meta、file-history-snapshot 等）全部过滤，避免噪音干扰。
 */

/** 一条可展示的对话消息 */
export interface JobOutputMessage {
  /** 消息角色：user=用户输入，assistant=助手输出 */
  role: 'user' | 'assistant'
  /** 消息正文（已拼接所有文本片段） */
  text: string
  /** 消息时间戳（毫秒），解析失败时为 null */
  timestamp: number | null
}

/**
 * 解析单条 SSE data 的 JSON，提取用户/助手消息。
 * @param raw data: 行之后的 JSON 字符串
 * @returns 解析出的消息；不是目标类型或解析失败时返回 null
 */
function parseEvent(raw: string): JobOutputMessage | null {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // 流传输中被截断的半块 JSON，忽略即可（下一批会带完整块）
    return null
  }

  // 只处理 message 类型，且角色必须是 user / assistant
  if (event.type !== 'message') return null
  const role = event.role
  if (role !== 'user' && role !== 'assistant') return null

  // content 中可能有多个文本片段，取所有 text 字段拼接
  const content = Array.isArray(event.content) ? event.content : []
  const text = content
    .map((item) => {
      if (typeof item !== 'object' || item === null) return ''
      const part = (item as Record<string, unknown>).text
      return typeof part === 'string' ? part : ''
    })
    .join('\n')
    .trim()

  if (!text) return null

  const timestamp = typeof event.timestamp === 'number' ? event.timestamp : null
  return { role, text, timestamp }
}

/**
 * 把 SSE 原始文本解析为可展示的对话列表。
 * 每个 SSE 事件以空行（\n\n）分隔，data 行以 "data: " 开头。
 * @param raw 原始 SSE 文本（jobOutput 的累加字符串）
 * @returns 按时间顺序排列的用户/助手消息数组
 */
export function parseJobOutput(raw: string): JobOutputMessage[] {
  if (!raw) return []
  const messages: JobOutputMessage[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data: '))
    if (!dataLine) continue
    const message = parseEvent(dataLine.slice('data: '.length))
    if (message) messages.push(message)
  }
  return messages
}
