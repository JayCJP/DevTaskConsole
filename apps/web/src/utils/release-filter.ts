import type { Build, MergeRequest, ViewerIdentity } from '@devtask/shared'

/**
 * 归一化身份文本：去首尾空格并转小写，便于跨系统比较账号与操作人。
 * @param value 原始文本，可能为空
 * @returns 归一化后的文本；无值时返回空字符串
 */
function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase()
}

/**
 * 只保留本人创建的合并请求。
 * 未识别到 GitLab 用户名时退回全量，避免身份查询失败导致发布页空白。
 * @param mergeRequests 快照中的全部合并请求
 * @param viewer 当前查看者身份
 * @returns 本人创建的合并请求列表
 */
export function filterOwnMergeRequests(
  mergeRequests: MergeRequest[],
  viewer: ViewerIdentity | undefined,
): MergeRequest[] {
  const username = normalize(viewer?.gitlabUsername)
  if (!username) return mergeRequests
  return mergeRequests.filter((mergeRequest) => normalize(mergeRequest.authorUsername) === username)
}

/**
 * 只保留本人触发的构建记录。
 * 未识别到 DevOps 登录账号时退回全量，与合并请求的降级策略保持一致。
 * @param builds 快照中的全部构建记录
 * @param viewer 当前查看者身份
 * @returns 本人触发的构建列表
 */
export function filterOwnBuilds(
  builds: Build[],
  viewer: ViewerIdentity | undefined,
): Build[] {
  const operator = normalize(viewer?.devopsOperator)
  if (!operator) return builds
  return builds.filter((build) => normalize(build.operator) === operator)
}
