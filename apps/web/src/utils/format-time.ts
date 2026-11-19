/**
 * 把时间值格式化为本地可读字符串。
 * 统一各组件/ composable 里散落的 `new Date(x).toLocaleString()` + 空值兜底，
 * 避免因参数类型不同（ISO 字符串 / 毫秒时间戳 / Date）各写一份。
 *
 * @param value 时间值；ISO 字符串、毫秒时间戳或 Date
 * @param fallback 无值时的占位文案，默认「未知」
 * @returns 本地时间字符串；无值时返回 fallback
 */
export function formatTime(value?: string | number | Date, fallback = '未知'): string {
  if (value === undefined || value === null || value === '') return fallback
  return new Date(value).toLocaleString()
}
