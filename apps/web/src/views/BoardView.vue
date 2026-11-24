<script setup lang="ts">
/**
 * board 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { computed, ref } from 'vue'
import { useConsoleContext } from '../composables/useConsoleContext'
import { phaseLabel, phaseTag } from '../utils/phase-labels'

const ctx = useConsoleContext()
// reactive(useBoardStories()) 跨 provide 边界后 TS 会把内部 ref 推断退化，
// 这里显式放宽为 any 以保留模板中 board.xxx 的自动解包行为（运行时对象未变）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const board = ctx.board as any
const {
  boardStatusTag,
  boardErrorHint,
  openRequirement,
  activeWorkflows,
  goCrons,
  refreshSegments,
  refreshWorkspaces,
  cronDispatches,
  actionToasts,
} = ctx

/** Story 状态刷新进行中（重扫本地数据，不查 TAPD） */
const storyRefreshing = ref(false)

/**
 * 刷新 Story 状态：一次同步所有本地数据，不查询 TAPD。
 * - local 段快照：工作区扫描 + Harness 阶段 / 活跃流程 + 收件箱条目；
 * - 定时任务派发（收件箱的 cron 轮次数据）；
 * - 本地工作区列表。
 * 顶栏全局刷新已移除，此按钮承担看板及跨页本地状态的刷新入口。
 * @returns Promise<void>
 */
async function refreshStoryState(): Promise<void> {
  if (storyRefreshing.value) return
  storyRefreshing.value = true
  try {
    await Promise.all([refreshSegments(['local']), cronDispatches.refresh(), refreshWorkspaces()])
    actionToasts.notify('Story 状态已刷新。', 'success')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    actionToasts.notify(`Story 状态刷新失败：${reason}`, 'error')
  } finally {
    storyRefreshing.value = false
  }
}

/**
 * 看板行最后一列的流水线态：把 board 行的本地工作区名关联到对应流水线。
 * 关联键用 workspaceName === pipeline.name（工作区名唯一），与流水线页的口径一致。
 * 只读展示，不做任何流程推进；没有绑定或工作区无 Story 时返回 undefined。
 */
interface BoardPipelineState {
  /** 运行模式中文名：run → 开发需求中，fixbugs → 修复缺陷中；非活跃时按阶段推断 */
  modeLabel: string
  /** 执行状态中文名：活跃流程 / 待启动 / 已归档 */
  statusLabel: string
  /** 状态语义色，用于分色渲染（仍带文字，不靠颜色单独传意） */
  tone: 'active' | 'fixing' | 'ready' | 'idle'
  /** 当前 Harness 阶段序号 P0-P6；无阶段时为 undefined */
  phase?: number
  /** 归属该 Story 的定时任务数量 */
  cronCount: number
  /** 下一个定时任务运行时间文本，无任务时为 undefined */
  nextRun?: string
}

/** 工作区名 → 流水线 的索引，避免每行重复 find */
const pipelineByName = computed(() => {
  const index = new Map<string, (typeof ctx.workspacePipelines.value)[number]>()
  for (const pipeline of ctx.workspacePipelines.value) index.set(pipeline.name, pipeline)
  return index
})

/** 活跃流程 storyId → 模式，用于识别 fixbugs 与 phase */
const activeModeByStory = computed(() => {
  const index = new Map<string, 'run' | 'fixbugs' | undefined>()
  for (const active of ctx.activeWorkflows.value) index.set(active.storyId, active.mode)
  return index
})

/**
 * 该看板行是否有进行中的活跃流程（harnessActive 存在其记录）。
 *
 * 注意口径：看板行的 story.storyId 是 TAPD 需求 ID（如 1138260628001031789），
 * 而 harnessActive 的 storyId 是本地 Harness Story ID（如 1102opt），两者不同。
 * 必须经绑定工作区拿到本地 Requirement，再用 Requirement.storyId 判断活跃，
 * 否则用 TAPD ID 直接查 activeModeByStory 永远命中不了、阶段 chip 不会渲染。
 *
 * 阶段 chip 与进度刻度都只在流程活跃时展示，统一用此判断避免口径分叉。
 * @param story 看板父需求行（含 workspaceName）
 * @returns 有活跃流程返回 true，否则 false
 */
function hasActiveFlow(story: { workspaceName?: string }): boolean {
  const requirement = requirementOf(story)
  return requirement ? activeModeByStory.value.has(requirement.storyId) : false
}

/** 看板每行 storyId → 流水线态，按绑定工作区名与流水线关联，随数据变化自动刷新 */
const boardPipelineStates = computed(() => {
  const index = new Map<string, BoardPipelineState>()
  for (const story of board.stories as Array<{ storyId: string; workspaceName?: string }>) {
    const state = pipelineStateOf(story)
    if (state) index.set(story.storyId, state)
  }
  return index
})

/** 看板每行 storyId → 本地 Requirement，用于在 ID 旁显示阶段并打开需求详情抽屉 */
const boardRequirements = computed(() => {
  const index = new Map<string, import('@devtask/shared').Requirement>()
  for (const story of board.stories as Array<{ storyId: string; workspaceName?: string }>) {
    const requirement = requirementOf(story)
    if (requirement) index.set(story.storyId, requirement)
  }
  return index
})

/**
 * 取看板行绑定的本地 Requirement（工作区流水线里的 Story）。
 * 未绑定工作区或工作区无本地 Story 时返回 undefined，此时不显示阶段、也不打开抽屉。
 * @param story 看板父需求行（含 workspaceName）
 * @returns 本地 Requirement；无则返回 undefined
 */
function requirementOf(story: {
  workspaceName?: string
}): import('@devtask/shared').Requirement | undefined {
  const name = story.workspaceName
  if (!name) return undefined
  return pipelineByName.value.get(name)?.story?.requirement
}

/**
 * 点击看板行的 story id：打开该需求的需求详情抽屉。
 * 只在存在本地 Requirement 时可用（抽屉依赖本地阶段与关联缺陷数据）。
 * @param story 看板父需求行
 */
function openStoryDetail(story: { storyId: string; workspaceName?: string }): void {
  const requirement = boardRequirements.value.get(story.storyId)
  if (requirement) openRequirement(requirement)
}

/**
 * 看板行 chip 显示的阶段中文名：复用与流水线页共享的 P0–P6 映射。
 * fixbugs 模式下 Phase 0 显示「bug分析」，其余按 run 口径。
 * 仅在流程活跃（harnessActive 存在该 Story）时返回阶段名；没有进行中的流程返回空串，chip 不渲染。
 * @param story 看板父需求行
 * @returns 中文阶段名；无活跃流程 / 无本地 Story 时返回空串（不渲染）
 */
function phaseLabelOf(story: { storyId: string; workspaceName?: string }): string {
  // 只有活跃流程才展示阶段 chip；harnessActive 里没有该 Story 时一律不显示
  if (!hasActiveFlow(story)) return ''
  const requirement = boardRequirements.value.get(story.storyId)
  if (!requirement) return ''
  const mode = activeModeByStory.value.get(requirement.storyId)
  return phaseLabel(requirement.phase, mode) ?? '阶段未知'
}

/**
 * 取看板行对应的 Harness 启动模式（用于阶段文案与刻度）。
 * 只有活跃流程带 mode；已归档 Story 未暴露该字段，按 run 口径处理。
 * @param story 看板父需求行
 * @returns 启动模式；无本地 Story 或未活跃时返回 undefined
 */
function modeOfStory(story: {
  storyId: string
  workspaceName?: string
}): 'run' | 'fixbugs' | undefined {
  const requirement = boardRequirements.value.get(story.storyId)
  return requirement ? activeModeByStory.value.get(requirement.storyId) : undefined
}

/**
 * 取某个看板行的流水线态。
 * @param story 看板父需求行（含 workspaceName）
 * @returns 流水线态；未绑定工作区或工作区无 Story 时返回 undefined
 */
function pipelineStateOf(story: { workspaceName?: string }): BoardPipelineState | undefined {
  const name = story.workspaceName
  if (!name) return undefined
  const pipeline = pipelineByName.value.get(name)
  const localStory = pipeline?.story
  if (!localStory) return undefined

  const requirement = localStory.requirement
  const mode = activeModeByStory.value.get(requirement.storyId)
  const isActive = localStory.harnessActive
  // 与流水线页同口径：定时数取 pipeline.crons（Story 任务 + 项目下未归属任务）
  const crons = pipeline?.crons ?? []
  const nextRun = crons.find((cron) => cron.nextRun)?.nextRun

  // 状态分色：活跃 fixbugs 最紧急（danger），活跃 run 次之（warning），
  // 有 Story 但未活跃为就绪（success），其余为空态（faint）。
  let tone: BoardPipelineState['tone'] = 'idle'
  let modeLabel = '已归档'
  let statusLabel = '本地待启动'
  if (isActive) {
    if (mode === 'fixbugs') {
      tone = 'fixing'
      modeLabel = '修复缺陷中'
      statusLabel = '流程活跃'
    } else {
      tone = 'active'
      modeLabel = '开发需求中'
      statusLabel = '流程活跃'
    }
  } else if (requirement.phase !== undefined) {
    tone = 'ready'
    modeLabel = '本地已就绪'
    statusLabel = '待启动'
  }

  return {
    modeLabel,
    statusLabel,
    tone,
    ...(requirement.phase !== undefined ? { phase: requirement.phase } : {}),
    cronCount: crons.length,
    ...(nextRun ? { nextRun: formatClock(nextRun) } : {}),
  }
}

/**
 * 把 ISO 时间压成 HH:mm，紧凑展示在状态条里。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无法解析时返回原值
 */
function formatClock(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 活跃流程的模式中文名，供汇总条展示。
 * @param mode Harness 启动模式（run / fixbugs）
 * @returns 中文模式名；未指定时返回「模式未知」
 */
function activeModeLabel(mode: 'run' | 'fixbugs' | undefined): string {
  if (mode === 'fixbugs') return '修复缺陷中'
  if (mode === 'run') return '开发需求中'
  return '模式未知'
}

/** Harness 阶段刻度 P0-P6 */
const phaseTicks = [0, 1, 2, 3, 4, 5, 6]
</script>

<template>
  <section class="surface">
    <!-- 全局活跃流程汇总：与流水线页同口径，让人一眼看到此刻有几个 Harness 流程在跑 -->
    <div
      v-for="workflow in activeWorkflows"
      :key="`${workflow.workspacePath}:${workflow.storyId}`"
      class="notice notice-warning"
    >
      <span class="notice-symbol">!</span>
      <div>
        <strong>Harness 活跃流程：{{ workflow.title }}</strong>
        <p>
          {{ workflow.storyId }} · {{ activeModeLabel(workflow.mode) }} ·
          {{ phaseTag(workflow.phase, workflow.mode) ?? '阶段未知' }} ·
          {{ workflow.status || '状态未知' }} · {{ workflow.workspacePath }}
        </p>
      </div>
    </div>
    <div class="section-heading">
      <div>
        <h2>需求总览</h2>
        <p>数据元以 TAPD 需求为准；每个需求可关联一个本地工作区</p>
      </div>
      <div class="board-controls">
        <el-input
          v-model="board.owner"
          class="board-owner-input"
          placeholder="TAPD 处理人"
          clearable
          @keyup.enter="board.load()"
          aria-label="按 TAPD 处理人筛选"
        />
        <el-select
          :model-value="board.includeReleased"
          class="board-filter"
          placeholder="状态筛选"
          @change="board.setIncludeReleased"
        >
          <el-option label="排除已发布（默认）" :value="false" />
          <el-option label="包含已发布" :value="true" />
        </el-select>
        <el-tooltip content="重新拉取 TAPD 需求列表与缺陷数，会消耗查询配额" placement="bottom">
          <el-button :loading="board.loading" @click="board.load(true)">刷新 TAPD</el-button>
        </el-tooltip>
        <el-tooltip
          content="重扫本地工作区、Harness 阶段与收件箱定时任务；不查询 TAPD"
          placement="bottom"
        >
          <el-button :loading="storyRefreshing" @click="refreshStoryState()"
            >刷新 Story 状态</el-button
          >
        </el-tooltip>
        <el-button type="primary" @click="board.openManual()">手动添加</el-button>
      </div>
    </div>
    <div class="board-meta">
      <span v-if="board.fetchedAt"
        >TAPD 拉取于 {{ new Date(board.fetchedAt).toLocaleString() }}</span
      >
      <span>{{ board.stories.length }} 个需求</span>
      <span v-if="!board.includeReleased && board.hiddenReleased" class="board-meta-hidden">
        已隐藏 {{ board.hiddenReleased }} 条已发布
        <el-button link type="primary" size="small" @click="board.setIncludeReleased(true)"
          >查看</el-button
        >
      </span>
      <span class="board-meta-status">
        <span class="tag" :class="boardStatusTag.tone">{{ boardStatusTag.label }}</span>
      </span>
    </div>
    <div v-if="board.error" class="notice notice-danger" role="alert">
      <span class="notice-symbol">!</span>
      <div>
        <strong>TAPD 需求查询失败</strong>
        <p>
          {{ boardErrorHint.reason }}。{{
            boardErrorHint.action
          }}。<br />下方仅显示本地已绑定、尚未同步到 TAPD 的需求。<br /><small
            class="board-error-detail"
            >{{ board.error }}</small
          >
        </p>
      </div>
      <el-button text @click="board.load(true)">重试</el-button>
    </div>
    <div v-if="board.stories.length" class="board-list">
      <article
        v-for="story in board.stories"
        :key="story.storyId"
        class="board-parent"
        :class="{ 'is-expanded': board.isParentExpanded(story.storyId) }"
      >
        <div class="board-row board-parent-row">
          <div class="board-main">
            <button
              type="button"
              class="board-expand-button"
              :aria-expanded="board.isParentExpanded(story.storyId)"
              :aria-label="board.isParentExpanded(story.storyId) ? '收起子需求' : '展开子需求'"
              @click="board.toggleParent(story.storyId)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <a :href="story.parentTapdUrl ?? story.tapdUrl" target="_blank" rel="noreferrer">{{
              story.title
            }}</a>
            <small>
              <code>{{ story.storyId }}</code>
              <span v-if="story.statusLabel || story.status" :title="story.status"
                >状态 {{ story.statusLabel ?? story.status }}</span
              >
              <span v-if="story.iterationName">{{ story.iterationName }}</span>
              <span v-if="story.owner">{{ story.owner }}</span>
              <span v-if="board.childrenOf(story).length" class="board-child-count"
                >{{ board.childrenOf(story).length }} 个子需求</span
              >
              <span v-if="story.bugNew || story.bugReopened" class="board-bug-count"
                >本人缺陷 {{ (story.bugNew ?? 0) + (story.bugReopened ?? 0) }}</span
              >
            </small>
            <!-- 本地流水线态：模式 / 状态 / 阶段 / 定时任务，按状态分色且带文字 -->
            <div
              v-if="boardPipelineStates.get(story.storyId)"
              class="board-pipeline"
              :class="`bp-tone-${boardPipelineStates.get(story.storyId)!.tone}`"
            >
              <!-- 中文阶段名：仅在流程活跃时显示，可点开需求详情抽屉；TAPD id 不在此行展示 -->
              <button
                v-if="phaseLabelOf(story)"
                type="button"
                class="board-story-link"
                :title="`打开需求详情 · ${phaseLabelOf(story)}`"
                @click="openStoryDetail(story)"
              >
                <span class="board-phase-chip">{{ phaseLabelOf(story) }}</span>
              </button>
              <span class="bp-mode">{{ boardPipelineStates.get(story.storyId)!.modeLabel }}</span>
              <span class="bp-status">{{
                boardPipelineStates.get(story.storyId)!.statusLabel
              }}</span>
              <span
                v-if="
                  hasActiveFlow(story) &&
                  boardPipelineStates.get(story.storyId)!.phase !== undefined
                "
                class="bp-phase"
                role="img"
                :aria-label="`Harness 阶段 ${phaseTag(boardPipelineStates.get(story.storyId)!.phase, modeOfStory(story))}`"
                :title="`Harness 阶段 ${phaseTag(boardPipelineStates.get(story.storyId)!.phase, modeOfStory(story))} / P6 构建部署`"
              >
                <i
                  v-for="tick in phaseTicks"
                  :key="tick"
                  class="bp-tick"
                  :class="{ 'is-passed': tick <= boardPipelineStates.get(story.storyId)!.phase! }"
                  aria-hidden="true"
                />
              </span>
              <button type="button" class="bp-crons" title="跳转到定时任务页" @click="goCrons()">
                定时 {{ boardPipelineStates.get(story.storyId)!.cronCount
                }}<template v-if="boardPipelineStates.get(story.storyId)!.nextRun">
                  · 下次 {{ boardPipelineStates.get(story.storyId)!.nextRun }}</template
                >
              </button>
            </div>
          </div>
          <div class="board-workspace">
            <el-select
              v-model="board.workspaceDraft[story.storyId]"
              clearable
              filterable
              placeholder="选择本地工作区"
              @change="board.bindSelected(story)"
            >
              <el-option
                v-for="workspace in board.workspaceOptionsFor(story)"
                :key="workspace.name"
                :label="workspace.name"
                :value="workspace.name"
              />
            </el-select>
            <code v-if="story.workspacePath">{{ story.workspacePath }}</code>
            <small v-else-if="story.workspaceName" class="mapping-error"
              >目录未找到：{{ story.workspaceName }}</small
            >
            <small v-if="!story.inTapdList" class="tag tag-warning">本地手动添加</small>
          </div>
          <div class="board-actions">
            <el-button
              size="small"
              :loading="board.unbindingStoryId === story.storyId"
              :disabled="!story.workspaceName"
              @click="board.unbindWorkspace(story.storyId)"
              >解绑</el-button
            >
          </div>
          <p v-if="board.rowErrors[story.storyId]" class="mapping-error" role="alert">
            {{ board.rowErrors[story.storyId] }}
          </p>
        </div>
        <div v-show="board.isParentExpanded(story.storyId)" class="board-children">
          <div
            v-for="child in board.childrenOf(story)"
            :key="child.storyId"
            class="board-row board-child-row"
          >
            <div class="board-main">
              <a :href="child.parentTapdUrl ?? child.tapdUrl" target="_blank" rel="noreferrer">{{
                child.title
              }}</a>
              <small>
                <code>{{ child.storyId }}</code>
                <span v-if="child.statusLabel || child.status" :title="child.status"
                  >状态 {{ child.statusLabel ?? child.status }}</span
                >
                <span v-if="child.owner">{{ child.owner }}</span>
              </small>
            </div>
            <div class="board-workspace">
              <small class="muted">工作区绑定在父需求上</small>
            </div>
          </div>
          <div v-if="!board.childrenOf(story).length" class="board-children-empty">
            该父需求下没有未发布的子需求。
          </div>
        </div>
      </article>
    </div>
    <div v-else-if="board.loading" class="empty-compact">正在查询 TAPD 需求…</div>
    <div v-else-if="board.error" class="notice notice-danger" role="alert">
      <span class="notice-symbol">!</span>
      <div>
        <strong>TAPD 需求查询失败</strong>
        <p>
          {{ boardErrorHint.reason }}。{{ boardErrorHint.action }}。<br /><small
            class="board-error-detail"
            >{{ board.error }}</small
          >
        </p>
      </div>
      <el-tooltip content="重新查询 TAPD；可能消耗查询配额" placement="left">
        <span><el-button text @click="board.load(true)">重试</el-button></span>
      </el-tooltip>
    </div>
    <div v-else class="empty-state">
      <strong>当前处理人「{{ board.owner }}」名下没有未发布需求</strong>
      <p>可检查姓名是否为 TAPD 中的写法，或用「手动添加」直接绑定需求链接。</p>
    </div>
  </section>

  <el-dialog
    v-model="board.manualOpen"
    title="手动添加需求"
    width="min(560px, 94vw)"
    :close-on-click-modal="false"
    @close="board.closeManual()"
  >
    <div class="board-manual-form">
      <label
        >TAPD 需求链接或 ID<el-input
          v-model="board.manualDraft.tapdStoryId"
          placeholder="https://www.tapd.cn/.../view/1138... 或纯数字 ID；子需求链接会自动绑定到其父需求"
      /></label>
      <label
        >需求名称（可选，TAPD 查询不到时展示）<el-input v-model="board.manualDraft.storyTitle"
      /></label>
      <label
        >关联本地工作区<el-select
          v-model="board.manualDraft.workspaceName"
          filterable
          placeholder="选择 *.code-workspace 识别出的工作区"
        >
          <el-option
            v-for="workspace in board.workspaces"
            :key="workspace.name"
            :label="workspace.name"
            :value="workspace.name"
          /> </el-select
      ></label>
    </div>
    <p v-if="board.manualError" class="mapping-error" role="alert">{{ board.manualError }}</p>
    <template #footer>
      <el-button @click="board.closeManual()">取消</el-button>
      <el-button type="primary" :loading="board.manualSaving" @click="board.submitManual()"
        >保存绑定</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
/*
 * story id + 阶段徽章：内联在元信息行，点击打开需求详情抽屉。
 * 视觉压到与元信息同权重，仅在 hover/focus 时抬一档，避免抢标题注意力。
 */
.board-story-link {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  font: inherit;
  line-height: 1.5;
  cursor: pointer;
}
.board-story-link:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
/* 阶段徽章：等宽、药丸底，中文阶段名一眼可读；数据色用 info，不抢主状态色 */
.board-phase-chip {
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--info-soft);
  color: var(--info);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 16px;
  transition:
    border-color 150ms ease,
    filter 150ms ease;
}
.board-story-link:hover .board-phase-chip,
.board-story-link:focus-visible .board-phase-chip {
  border-color: var(--info);
  filter: brightness(1.12);
}

/*
 * 看板行内的本地流水线态条：模式 / 状态 / 阶段 / 定时任务。
 * 视觉从 DESIGN.md 的 instrument + signal token 派生；状态同时用底色、文字色和文字标签
 * 三处编码，去掉颜色后仍可读（状态自述、不靠颜色单独传意）。
 * 放在 .board-main 的第 2 列，与标题、元信息同列，不破坏父行的三列网格。
 */
.board-pipeline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  /* 复用项目已有的凹槽 token：半透明 surface-raised 在亮色下与卡片几乎同色，整条会消失 */
  background: var(--bg-inset);
  font-size: 11px;
  line-height: 1.5;
}
/* 展开按钮跨三行：标题 / 元信息 / 流水线态条 */
.board-parent-row .board-main .board-expand-button {
  grid-row: 1 / span 3;
}

/* 模式徽章：药丸底色承担主状态色，文字用同色阶加深一档保证对比 */
.bp-mode {
  padding: 1px 7px;
  border-radius: 999px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.bp-status {
  color: var(--text-muted);
  white-space: nowrap;
}
.bp-crons {
  /* text-faint 在面板底色上只有约 3.9:1，小字不达标；用 muted（约 6.8:1） */
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  /* button 重置：保持与静态文本同重，只在交互时抬一档 */
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  cursor: pointer;
  transition: color 150ms ease;
}
.bp-crons:hover {
  color: var(--accent);
  text-decoration: underline;
}
.bp-crons:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

/* fixbugs 活跃：danger（最高优先级告警） */
.bp-tone-fixing .bp-mode {
  background: var(--danger-soft);
  color: var(--danger);
}
.bp-tone-fixing .bp-status {
  color: var(--danger);
}

/* run 活跃：warning（进行中） */
.bp-tone-active .bp-mode {
  background: var(--warning-soft);
  color: var(--warning);
}
.bp-tone-active .bp-status {
  color: var(--warning);
}

/* 未活跃但有 Story：success（就绪，等待启动） */
.bp-tone-ready .bp-mode {
  background: var(--success-soft);
  color: var(--success);
}

/* 空/归档：淡底色保持低显著性，文字仍需达到正文对比（text-faint 仅约 3.9:1） */
.bp-tone-idle .bp-mode {
  background: color-mix(in oklch, var(--text-faint) 14%, transparent);
  color: var(--text-muted);
}

/*
 * 阶段刻度：沿用流水线页的「实心已过 / 空心未过」双编码，尺寸缩小到行内。
 * 当前阶段的色跟随 tone，让阶段条与主状态同色系，避免同一行出现两套语义色。
 */
/* 不把刻度推到右侧：整条状态信息左对齐成一组，避免在宽屏上被空白割裂成两段 */
.bp-phase {
  display: inline-flex;
  gap: 3px;
}
.bp-tick {
  width: 12px;
  height: 3px;
  /* 未过段用 text-faint 而非 line-strong：后者在亮色主题仅约 2:1，空心刻度几乎看不见 */
  border: 1px solid var(--text-faint);
  border-radius: var(--radius-xs);
  background: transparent;
}
.bp-tick.is-passed {
  border-color: currentColor;
  background: currentColor;
}
.bp-tone-fixing .bp-phase {
  color: var(--danger);
}
.bp-tone-active .bp-phase {
  color: var(--warning);
}
.bp-tone-ready .bp-phase {
  color: var(--success);
}
.bp-tone-idle .bp-phase {
  color: var(--text-faint);
}

/* 窄屏：收紧状态条内部间距，避免小屏上折行过多 */
@media (max-width: 720px) {
  .board-pipeline {
    gap: 4px 8px;
  }
}
</style>
