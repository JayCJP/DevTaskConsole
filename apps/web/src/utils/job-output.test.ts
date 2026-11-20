import { describe, expect, it } from 'vitest'
import { parseJobOutput } from './job-output'

/** 构造一条 SSE 事件块 */
function sse(data: object): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n`
}

describe('parseJobOutput', () => {
  it('只保留用户与助手消息，过滤工具调用与心跳等噪音', () => {
    const raw = [
      sse({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }),
      sse({
        type: 'function_call',
        name: 'Bash',
        arguments: '{}',
      }),
      sse({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '在的' }],
      }),
      'event: keepalive\ndata: {}\n',
      sse({ type: 'session-meta', id: 'x' }),
    ].join('\n')

    expect(parseJobOutput(raw)).toEqual([
      { role: 'user', text: '你好', timestamp: null },
      { role: 'assistant', text: '在的', timestamp: null },
    ])
  })

  it('拼接同条消息内的多个文本片段并保留时间戳', () => {
    const raw = sse({
      type: 'message',
      role: 'assistant',
      timestamp: 1795154963116,
      content: [
        { type: 'output_text', text: '第一行' },
        { type: 'output_text', text: '第二行' },
      ],
    })
    expect(parseJobOutput(raw)).toEqual([
      { role: 'assistant', text: '第一行\n第二行', timestamp: 1795154963116 },
    ])
  })

  it('忽略解析失败的半块与无正文消息', () => {
    const raw = [
      'event: message\ndata: {"type":"message","role":"user"', // 被截断的 JSON
      sse({ type: 'message', role: 'assistant', content: [] }), // 无正文
    ].join('\n')
    expect(parseJobOutput(raw)).toEqual([])
  })

  it('空输入返回空数组', () => {
    expect(parseJobOutput('')).toEqual([])
  })
})
