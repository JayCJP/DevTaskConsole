import { describe, expect, it } from 'vitest'
import type { Build, MergeRequest } from '@devtask/shared'
import { filterOwnBuilds, filterOwnMergeRequests } from './release-filter'

/**
 * 构造一条最小可用的合并请求。
 * @param id MR 编号
 * @param authorUsername 作者用户名，缺省表示上游未返回作者
 * @returns 合并请求对象
 */
function mergeRequest(id: string, authorUsername?: string): MergeRequest {
  return {
    projectId: 1,
    id,
    title: `MR ${id}`,
    sourceBranch: 'feat/x',
    targetBranch: 'dev',
    state: 'opened',
    ...(authorUsername ? { authorUsername } : {}),
  }
}

/**
 * 构造一条最小可用的构建记录。
 * @param id 构建 ID
 * @param operator 触发人，缺省表示上游未返回操作人
 * @returns 构建记录对象
 */
function build(id: string, operator?: string): Build {
  return { id, app: 'repo-a', succeed: true, ...(operator ? { operator } : {}) }
}

describe('发布页本人过滤', () => {
  it('只保留本人创建的合并请求，忽略大小写', () => {
    const rows = [mergeRequest('1', 'CaiJiePeng'), mergeRequest('2', 'someone-else'), mergeRequest('3')]

    expect(filterOwnMergeRequests(rows, { gitlabUsername: 'caijiepeng' }).map((row) => row.id)).toEqual(['1'])
  })

  it('只保留本人触发的构建', () => {
    const rows = [build('a', 'caijiepeng'), build('b', 'someone-else'), build('c')]

    expect(filterOwnBuilds(rows, { devopsOperator: 'caijiepeng' }).map((row) => row.id)).toEqual(['a'])
  })

  it('无法识别身份时退回全量，避免发布页空白', () => {
    const rows = [mergeRequest('1', 'someone-else')]
    const builds = [build('a', 'someone-else')]

    expect(filterOwnMergeRequests(rows, undefined)).toEqual(rows)
    expect(filterOwnMergeRequests(rows, { devopsOperator: 'caijiepeng' })).toEqual(rows)
    expect(filterOwnBuilds(builds, { gitlabUsername: 'caijiepeng' })).toEqual(builds)
    expect(filterOwnBuilds(builds, undefined)).toEqual(builds)
  })
})
