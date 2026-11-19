/**
 * 已知数据通道的展示顺序与中文名。
 * 快照里完全没有该 key 时仍然要列出来并标注「未检测」，
 * 否则用户看到的是一句兜底话，而不是「哪条通道没接」。
 */
export const CHANNEL_CATALOG = [
  { key: 'tapd', label: 'TAPD', purpose: '需求与缺陷' },
  { key: 'gitlab', label: 'GitLab', purpose: '合并请求' },
  { key: 'devops', label: 'DevOps', purpose: '构建与部署' },
  { key: 'codebuddy', label: 'CodeBuddy', purpose: '实例与轮次' },
  { key: 'crons', label: '定时任务', purpose: 'scheduled_tasks.json' },
  { key: 'localHarness', label: '本地 Harness', purpose: 'e2e-state 与工作区' },
] as const

/** 已知通道 key 列表，供顶栏连接状态与工具页共用 */
export const KNOWN_CHANNEL_KEYS: readonly string[] = CHANNEL_CATALOG.map((entry) => entry.key)

/**
 * 判断顶栏连接状态是否应显示告警。
 * 快照未加载、全局错误、任一已知通道失败或缺失，都按需检查处理，
 * 避免出现「看板报错、顶栏却写连接正常」的矛盾。
 *
 * @param channels 快照中的通道状态
 * @param hasGlobalError 是否已有全局错误
 * @returns 任一已知通道不可用时返回 true
 */
export function hasChannelWarning(
  channels: Record<string, { ok: boolean } | undefined> | undefined,
  hasGlobalError: boolean,
): boolean {
  if (hasGlobalError || !channels) return true
  return KNOWN_CHANNEL_KEYS.some((key) => !channels[key]?.ok)
}
