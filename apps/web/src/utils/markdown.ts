/**
 * Markdown 渲染工具：把 Job 输出中的助手/用户文本渲染为安全 HTML。
 * 内容来自上游 agent，属不可信输入，因此必须关闭原始 HTML 与危险协议。
 */
import MarkdownIt from 'markdown-it'

/** 单实例复用：markdown-it 实例无状态、可安全共享 */
const md = new MarkdownIt({
  // 禁止原始 HTML：不可信文本里的 <script>/<img onerror> 等会被转义而非执行
  html: false,
  // 自动把裸 URL 转成链接
  linkify: true,
  // 单个换行渲染为 <br>，贴合终端/日志输出的换行语义
  breaks: true,
})

/** markdown-it 默认的 open 链接渲染规则类型签名 */
type LinkOpenRenderer = (tokens: unknown[], idx: number) => string

/** 原链接渲染器，供包装复用 */
const defaultLinkOpen = md.renderer.rules.link_open as LinkOpenRenderer | undefined

/**
 * 给所有链接补上安全属性：新标签页打开并断开 rel，避免 tabnabbing。
 * @param tokens 链接 token 列表
 * @param idx 当前 token 下标
 * @returns 渲染后的开标签 HTML
 */
md.renderer.rules.link_open = function renderSafeLinkOpen(tokens, idx): string {
  const token = (tokens as Array<{ attrSet: (key: string, value: string) => void }>)[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  if (defaultLinkOpen) return defaultLinkOpen(tokens, idx)
  return md.renderer.renderToken(tokens as never[], idx, {})
}

/**
 * 把 Markdown 文本渲染为安全 HTML。
 * @param text 原始 Markdown 文本（不可信）
 * @returns 经过转义与链接加固的 HTML 字符串
 */
export function renderMarkdown(text: string): string {
  return md.render(text)
}
