import { computed, ref } from 'vue'
import {
  boardResponseSchema,
  defaultTapdOwner,
  workspaceBindingSchema,
  type BoardStory,
  type WorkspaceSummary,
} from '@devtask/shared'
import { apiRequest } from '../api/client'

/** 看板默认查询的 TAPD 处理人；值来自共享常量，保留导出名以兼容既有引用 */
export const defaultBoardOwner = defaultTapdOwner

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
  /** 父行工作区下拉的编辑草稿，key 为父需求 ID（子需求不绑定工作区） */
  const workspaceDraft = ref<Record<string, string>>({})
  /** 当前展开的父需求 ID 集合（看板按「父一行、子折叠」展示） */
  const expandedParentIds = ref<Set<string>>(new Set())
  const manualOpen = ref(false)
  const manualDraft = ref<ManualDraft>({ tapdStoryId: '', storyTitle: '', workspaceName: '' })
  const manualError = ref('')
  const manualSaving = ref(false)

  /** 已被其它父需求绑定的工作区名，用于下拉去重（工作区只绑定在父需求上） */
  const boundWorkspaceNames = computed(
    () =>
      new Set(stories.value.flatMap((story) => (story.workspaceName ? [story.workspaceName] : []))),
  )

  /**
   * 判断某个父需求行是否处于展开状态。
   * @param storyId 父需求 ID
   * @returns 是否展开
   */
  function isParentExpanded(storyId: string): boolean {
    return expandedParentIds.value.has(storyId)
  }

  /**
   * 切换父需求行的展开/收起状态。
   * @param storyId 父需求 ID
   */
  function toggleParent(storyId: string): void {
    const next = new Set(expandedParentIds.value)
    if (next.has(storyId)) next.delete(storyId)
    else next.add(storyId)
    expandedParentIds.value = next
  }

  /**
   * 返回父行的折叠子需求列表（缺省视为空数组）。
   * @param story 看板行
   * @returns 子需求数组
   */
  function childrenOf(story: BoardStory) {
    return story.children ?? []
  }

  /**
   * 用外部扫描结果覆盖看板的工作区选项列表。
   *
   * 供「刷新工作区」类按钮调用：只更新下拉候选，不查询 TAPD、不改写 stories
   * 与 workspaceDraft，避免打断用户未保存的下拉编辑。
   * @param list 最新工作区摘要列表（复制后保存，避免与调用方共享同一数组引用）
   */
  function setWorkspaces(list: WorkspaceSummary[]): void {
    workspaces.value = [...list]
  }

  /**
   * 绑定变更后就地更新看板状态，不重新查询 TAPD。
   *
   * 绑定操作只改变 workspaceName/workspacePath/workspaceFile/boundAt 等关联字段，
   * 需求本身（标题/状态/缺陷数/子需求）不受影响，因此无需重拉整个看板列表。
   * 路径类字段从本地 workspaces 推导，boundAt 使用服务端返回的权威时间。
   * @param storyId 目标需求 ID
   * @param workspaceName 新绑定的工作区名；空串表示解绑
   * @param boundAt 服务端绑定记录中的 updatedAt（解绑时无需传）
   */
  function applyBindingLocally(storyId: string, workspaceName: string, boundAt?: string): void {
    const workspace = workspaceName
      ? workspaces.value.find((item) => item.name === workspaceName)
      : undefined
    stories.value = stories.value.map((story) => {
      if (story.storyId !== storyId) return story
      // 先剔除全部关联字段，避免解绑时残留旧的 workspacePath/workspaceFile/boundAt
      const { workspacePath: _path, workspaceFile: _file, boundAt: _boundAt, ...rest } = story
      return workspaceName
        ? {
            ...rest,
            workspaceName,
            ...(workspace?.path ? { workspacePath: workspace.path } : {}),
            ...(workspace?.workspaceFile ? { workspaceFile: workspace.workspaceFile } : {}),
            ...(boundAt ? { boundAt } : {}),
          }
        : { ...rest, workspaceName: '' }
    })
    // 草稿与已保存绑定保持一致；只改单行，避免打断其它行未保存的编辑
    workspaceDraft.value = { ...workspaceDraft.value, [storyId]: workspaceName }
  }

  /**
   * 计算某一行可选的工作区：排除已绑定给其他父需求的工作区，保留自身当前绑定。
   * @param story 看板父行（工作区只绑定在父需求上）
   * @returns 可选项工作区列表
   */
  function workspaceOptionsFor(
    story: Pick<BoardStory, 'storyId' | 'workspaceName'>,
  ): WorkspaceSummary[] {
    return workspaces.value.filter(
      (workspace) =>
        workspace.name === story.workspaceName || !boundWorkspaceNames.value.has(workspace.name),
    )
  }

  /**
   * 拉取看板数据（含 TAPD 需求列表与工作区绑定）。
   *
   * 注意：绑定/解绑不再调用本函数，而是就地更新关联字段，避免消耗 TAPD 配额。
   * 只有「刷新 TAPD」按钮、owner/includeReleased 变化等场景才需要调用。
   * @param force 是否穿透服务端文件缓存强制回源重新查询 TAPD
   * @returns Promise<void>，失败信息写入 error
   */
  async function load(force = false): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const query = new URLSearchParams({
        owner: owner.value.trim(),
        includeReleased: includeReleased.value ? '1' : '0',
        ...(force ? { refresh: '1' } : {}),
      })
      const payload: unknown = await apiRequest(`/api/v1/board/stories?${query}`)
      const parsed = boardResponseSchema.parse(payload)
      stories.value = parsed.stories
      workspaces.value = parsed.workspaces
      fetchedAt.value = parsed.fetchedAt ?? ''
      channelOk.value = parsed.ok
      hiddenReleased.value = parsed.hiddenReleased
      // 刷新后把父行下拉重置为服务端已保存的绑定，避免残留未保存的编辑
      // 工作区只绑定在父需求上，子需求不参与绑定
      workspaceDraft.value = Object.fromEntries(
        parsed.stories.map((story) => [story.storyId, story.workspaceName ?? '']),
      )
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
   * 保存一条绑定关系并就地更新看板状态。
   *
   * 服务端 PUT 返回保存后的完整绑定列表（含权威 updatedAt），据此更新对应行，
   * 不重新拉取 TAPD 需求列表——绑定只改变关联字段，不影响需求本身。
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
      const bindings = workspaceBindingSchema.array().parse(
        await apiRequest('/api/v1/workspace-bindings', {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      )
      // 服务端会把子需求归一化为父需求 ID，取返回记录里的实际 ID 与时间，避免本地不一致
      const saved = bindings.find((binding) => binding.workspaceName === input.workspaceName)
      applyBindingLocally(
        saved?.tapdStoryId ?? input.tapdStoryId,
        input.workspaceName,
        saved?.updatedAt,
      )
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
   * @param story 看板父行（工作区只绑定在父需求上）
   * @returns Promise<void>
   */
  async function bindSelected(
    story: Pick<BoardStory, 'storyId' | 'workspaceName' | 'title' | 'tapdUrl'>,
  ): Promise<void> {
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
      await apiRequest(`/api/v1/workspace-bindings/${encodeURIComponent(storyId)}`, {
        method: 'DELETE',
      })
      // 解绑只清空关联字段，就地更新即可，无需重拉 TAPD
      applyBindingLocally(storyId, '')
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
      // 手动新增绑定改变了绑定关系，穿透文件缓存强制回源
      await load(true)
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
    expandedParentIds,
    isParentExpanded,
    toggleParent,
    childrenOf,
    manualOpen,
    manualDraft,
    manualError,
    manualSaving,
    workspaceOptionsFor,
    setWorkspaces,
    load,
    setIncludeReleased,
    bindSelected,
    unbindWorkspace,
    openManual,
    closeManual,
    submitManual,
  }
}
