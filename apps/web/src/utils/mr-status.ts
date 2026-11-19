import type { WorkspaceMergeRequestCreateItem } from '@devtask/shared'

/** 合并请求单项结果状态 */
export type MrStatus = WorkspaceMergeRequestCreateItem['status']

/** 状态 → 中文文案，工作区抽屉与发布页结果弹窗共用 */
export function mrStatusLabel(status: MrStatus): string {
  return { created: '已创建', exists: '已存在', failed: '失败' }[status]
}

/** 状态 → 标签样式类，工作区抽屉与发布页结果弹窗共用 */
export function mrStatusClass(status: MrStatus): string {
  return { created: 'tag-success', exists: 'tag-warning', failed: 'tag-danger' }[status]
}
