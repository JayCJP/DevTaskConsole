import type { BoardResponse } from '@devtask/shared'

/** 测试夹具统一使用的时间戳与缓存键 */
export const FIXTURE_AT = '2026-11-18T00:00:00.000Z'
export const FIXTURE_KEY = '蔡杰鹏|0'

/**
 * 构造最小合法的看板响应，供缓存读写测试共用。
 * @param options.at 抓取时间
 * @param options.storyId 可选 Story ID，便于区分不同 key 的响应
 * @returns 合法的看板响应
 */
export function makeBoardResponse(options: {
  at?: string
  storyId?: string
} = {}): BoardResponse {
  const at = options.at ?? FIXTURE_AT
  return {
    owner: '蔡杰鹏',
    fetchedAt: at,
    ok: true,
    includeReleased: false,
    hiddenReleased: 0,
    stories: options.storyId
      ? [{
        storyId: options.storyId,
        title: `Story ${options.storyId}`,
        tapdUrl: `https://www.tapd.cn/38260062/prong/stories/view/${options.storyId}`,
        inTapdList: true,
      }]
      : [],
    workspaces: [],
  }
}
