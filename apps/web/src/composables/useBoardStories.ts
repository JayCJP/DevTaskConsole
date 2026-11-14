import { computed, ref } from 'vue'
import { boardResponseSchema, type BoardStory, type WorkspaceSummary } from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 看板默认查询的 TAPD 处理人 */
export const defaultBoardOwner = '蔡杰鹏'

/** 手动添加需求时的表单草稿 */
interface ManualDraft {
  /** TAPD 需求链接或纯数字 ID */
  tapdStoryId: string
  /** 需求名称，仅用于 TAPD 查询不到的本地记录 */
  storyTitle: string
  /** 关联的本地工作区名 */
  workspaceName: string
}

/**
 * 看板数据（TAPD 需求 × 本地工作区绑定）。
 * 数据元以 TAPD 需求为准；工作区绑定保存在控制台本地。
 * @param initialOwner 初始 TAPD 处理人
 */
export function useBoardStories(initialOwner = defaultBoardOwner) {
  const owner = ref(initialOwner)
  const stories = ref<BoardStory[]>([])
  const workspaces = ref<WorkspaceSummary[]>([])
  const fetchedAt = ref('')
  const channelOk = ref(false)
  /** 是否显示“已发布”需求；默认 false（排除终态需求） */
  const includeReleased = ref(false)
  /** 被默认筛选隐藏的已发布需求数量 */
  const hiddenReleased = ref(0)
  const loading = ref(false)
  const error = ref('')
  /** 正在保存绑定的需求 ID */
  const savingStoryId = ref('')
  /** 正在解绑的需求 ID */
  const unbindingStoryId = ref('')
  /** 行级保存错误，按需求 ID 记录 */
  const rowErrors = ref<Record<string, string>>({})
  /** 行内工作区下拉的编辑草稿，key 为 TAPD 需求 ID */
  const workspaceDraft = ref<Record<string, string>>({})
  const manualOpen = ref(false)
  const manualDraft = ref<ManualDraft>({ tapdStoryId: '', storyTitle: '', workspaceName: '' })
  const manualError = ref('')
  const manualSaving = ref(false)

  /** 已被其他需求绑定的工作区名，用于下拉去重 */
  const boundWorkspaceNames = computed(() => new Set(
    stories.value.flatMap((story) => (story.workspaceName ? [story.workspaceName] : [])),
  ))

  /**
   * 计算某一行可选的工作区：排除已绑定给其他需求的工作区，保留自身当前绑定。
   * @param story 看板行
   * @returns 可选项工作区列表
   */
  function workspaceOptionsFor(story: BoardStory): WorkspaceSummary[] {
    return workspaces.value.filter((workspace) =>
      workspace.name === story.workspaceName || !boundWorkspaceNames.value.has(workspace.name))
  }

  /**
   * 拉取看板数据。
   * @returns Promise<void>，失败信息写入 error
   */
  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const query = new URLSearchParams({
        owner: owner.value.trim(),
        includeReleased: includeReleased.value ? '1' : '0',
      })
      const payload: unknown = await apiRequest(`/api/v1/board/stories?${query}`)
      const parsed = boardResponseSchema.parse(payload)
      stories.value = parsed.stories
      workspaces.value = parsed.workspaces
      fetchedAt.value = parsed.fetchedAt ?? ''
      channelOk.value = parsed.ok
      hiddenReleased.value = parsed.hiddenReleased
      // 刷新后把行内下拉重置为服务端已保存的绑定，避免残留未保存的编辑
      workspaceDraft.value = Object.fromEntries(parsed.stories.map((story) => [story.storyId, story.workspaceName ?? '']))
      if (parsed.error) error.value = parsed.error
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '看板数据加载失败。'
    } finally {
      loading.value = false
    }
  }

  /**
   * 切换“是否显示已发布需求”并重新加载列表。
   * @param value true 表示包含已发布需求
   * @returns Promise<void>
   */
  async function setIncludeReleased(value: boolean): Promise<void> {
    if (includeReleased.value === value) return
    includeReleased.value = value
    await load()
  }

  /**
   * 保存一条绑定关系并刷新列表。
   * @param input TAPD 需求与其要绑定的工作区
   * @returns Promise<boolean> 是否保存成功
   */
  async function saveBinding(input: {
    tapdStoryId: string
    workspaceName: string
    storyTitle?: string
    tapdUrl?: string
  }): Promise<boolean> {
    savingStoryId.value = input.tapdStoryId
    rowErrors.value = { ...rowErrors.value, [input.tapdStoryId]: '' }
    try {
      await apiRequest('/api/v1/workspace-bindings', {
        method: 'PUT',
        body: JSON.stringify(input),
      })
      await load()
      return true
    } catch (cause) {
      rowErrors.value = {
        ...rowErrors.value,
        [input.tapdStoryId]: cause instanceof Error ? cause.message : '绑定保存失败。',
      }
      return false
    } finally {
      savingStoryId.value = ''
    }
  }

  /**
   * 保存某一行下拉中选择的工作区；清空选择时等价于解绑。
   * @param story 看板行
   * @returns Promise<void>
   */
  async function bindSelected(story: BoardStory): Promise<void> {
    const workspaceName = workspaceDraft.value[story.storyId] ?? ''
    if (!workspaceName) {
      if (story.workspaceName) await unbindWorkspace(story.storyId)
      return
    }
    await saveBinding({
      tapdStoryId: story.storyId,
      workspaceName,
      storyTitle: story.title,
      tapdUrl: story.tapdUrl,
    })
  }

  /**
   * 解除某个需求的绑定。
   * @param storyId TAPD 需求 ID
   * @returns Promise<void>
   */
  async function unbindWorkspace(storyId: string): Promise<void> {
    unbindingStoryId.value = storyId
    rowErrors.value = { ...rowErrors.value, [storyId]: '' }
    try {
      await apiRequest(`/api/v1/workspace-bindings/${encodeURIComponent(storyId)}`, { method: 'DELETE' })
      await load()
    } catch (cause) {
      rowErrors.value = {
        ...rowErrors.value,
        [storyId]: cause instanceof Error ? cause.message : '解绑失败。',
      }
    } finally {
      unbindingStoryId.value = ''
    }
  }

  /** 重置并打开手动添加弹窗。 */
  function openManual(): void {
    manualDraft.value = { tapdStoryId: '', storyTitle: '', workspaceName: '' }
    manualError.value = ''
    manualOpen.value = true
  }

  /** 关闭手动添加弹窗。 */
  function closeManual(): void {
    if (manualSaving.value) return
    manualOpen.value = false
  }

  /**
   * 提交手动添加的需求绑定。
   * @returns Promise<void>
   */
  async function submitManual(): Promise<void> {
    const draft = manualDraft.value
    if (!draft.tapdStoryId.trim() || !draft.workspaceName) {
      manualError.value = '请填写 TAPD 需求链接或 ID，并选择本地工作区。'
      return
    }
    manualSaving.value = true
    manualError.value = ''
    try {
      // 手动添加使用输入值原样提交，服务端负责从链接中提取需求 ID
      await apiRequest('/api/v1/workspace-bindings', {
        method: 'PUT',
        body: JSON.stringify({
          tapdStoryId: draft.tapdStoryId.trim(),
          workspaceName: draft.workspaceName,
          ...(draft.storyTitle.trim() ? { storyTitle: draft.storyTitle.trim() } : {}),
        }),
      })
      manualOpen.value = false
      await load()
    } catch (cause) {
      manualError.value = cause instanceof Error ? cause.message : '绑定保存失败。'
    } finally {
      manualSaving.value = false
    }
  }

  return {
    owner,
    stories,
    workspaces,
    fetchedAt,
    channelOk,
    includeReleased,
    hiddenReleased,
    loading,
    error,
    savingStoryId,
    unbindingStoryId,
    rowErrors,
    workspaceDraft,
    manualOpen,
    manualDraft,
    manualError,
    manualSaving,
    workspaceOptionsFor,
    load,
    setIncludeReleased,
    bindSelected,
    unbindWorkspace,
    openManual,
    closeManual,
    submitManual,
  }
}
