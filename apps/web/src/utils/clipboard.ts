/**
 * 把文本复制到剪贴板。
 * 优先用现代 Clipboard API；被浏览器策略禁用时回退到 execCommand。
 * 所有「复制」场景统一走这里，避免多处各写一套降级逻辑。
 *
 * @param text 待复制文本
 * @returns 复制成功返回 true；两种 API 都失败返回 false
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒或不可用，继续尝试 execCommand 兜底
  }
  try {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.setAttribute('readonly', '')
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.appendChild(helper)
    helper.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(helper)
    return ok
  } catch {
    return false
  }
}
