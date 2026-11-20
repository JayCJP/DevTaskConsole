import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('渲染 Markdown 标题、列表与代码块', () => {
    const html = renderMarkdown('# 标题\n\n- 项目一\n- 项目二\n\n```\n/clear\n```')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>')
  })

  it('转义不可信原始 HTML，防止 XSS', () => {
    const html = renderMarkdown('<script>alert(1)</script> & <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('给链接加固 target 与 rel', () => {
    const html = renderMarkdown('[文档](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('单换行渲染为 br，贴合日志输出', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>')
  })
})
