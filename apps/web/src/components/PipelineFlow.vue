<script setup lang="ts">
import { computed } from 'vue'
import { Document, FolderOpened, Timer } from '@element-plus/icons-vue'
import type { Requirement, WorkspacePipeline } from '@devtask/shared'
import { phaseLabel, phaseTag, type HarnessMode } from '../utils/phase-labels'

/**
 * 流水线可视化：一个工作区一条水平轨道，节点依次为 工作区 → Story → 定时。
 * 只读展示源系统状态；节点点击只做跳转，不推进流程。
 */
const props = defineProps<{
  pipelines: WorkspacePipeline[]
  /** 活跃流程 storyId → 启动模式；Phase 0 文案据此区分需求分析与 bug分析 */
  activeModes?: Map<string, HarnessMode>
}>()

const emit = defineEmits<{
  (event: 'open-story', requirement: Requirement): void
  (event: 'go-crons'): void
}>()

/** 节点状态色：ready=有数据，active=正在流转，empty=暂无，danger=失败 */
type StageTone = 'ready' | 'active' | 'empty' | 'danger'

interface FlowStage {
  key: 'workspace' | 'story' | 'cron'
  label: string
  value: string
  hint: string
  tone: StageTone
  /**
   * 该节点是否有可跳转的目标对象。
   * 只有 true 的节点才渲染成可交互按钮；空态节点是静态读数，不能伪装成「按下去就执行」。
   */
  target: boolean
}

interface FlowRow {
  key: string
  name: string
  path: string
  projectLabel: string
  branch?: string
  worktree: boolean
  active: boolean
  storyCandidates: number
  title: string
  storyId?: string
  phase?: number
  mode?: HarnessMode
  requirement?: Requirement
  stages: FlowStage[]
}

const rows = computed<FlowRow[]>(() =>
  props.pipelines.map((pipeline) => {
    const story = pipeline.story
    const requirement = story?.requirement
    const mode = requirement ? props.activeModes?.get(requirement.storyId) : undefined
    const nextRun = pipeline.crons.find((cron) => cron.nextRun)?.nextRun
    const project = pipeline.primaryProject

    const stages: FlowStage[] = [
      {
        key: 'workspace',
        label: '工作区',
        value: project ? (project.worktree ? 'worktree' : '独立克隆') : '未声明',
        hint: project?.name ?? '未声明项目',
        tone: project ? 'ready' : 'empty',
        // 工作区节点只是这一行的起点标识，任何情况下都不承担跳转
        target: false,
      },
      {
        key: 'story',
        label: 'Story',
        // 阶段直接显示中文名（如「代码审查」）；fixbugs 模式下 P0 显示「bug分析」
        value: requirement ? (phaseLabel(requirement.phase, mode) ?? '阶段未知') : '—',
        hint: requirement ? requirement.storyId : '等待 plans',
        tone: story ? (story.harnessActive ? 'active' : 'ready') : 'empty',
        target: Boolean(requirement),
      },
      {
        key: 'cron',
        label: '定时',
        value: String(pipeline.crons.length),
        hint: nextRun
          ? `下次 ${formatTime(nextRun)}`
          : pipeline.crons.length
            ? '已配置'
            : '暂无任务',
        tone: pipeline.crons.length ? 'ready' : 'empty',
        // 定时节点跳到定时任务页，与单个任务是否存在无关
        target: true,
      },
    ]

    return {
      key: pipeline.path,
      name: pipeline.name,
      path: pipeline.path,
      projectLabel: project?.name ?? '未声明项目',
      ...(project?.branch ? { branch: project.branch } : {}),
      worktree: project?.worktree ?? false,
      active: Boolean(story?.harnessActive),
      storyCandidates: pipeline.storyCandidates,
      title: requirement?.title ?? '第一个项目里还没有 Story',
      ...(requirement ? { storyId: requirement.storyId } : {}),
      ...(requirement ? { phase: requirement.phase } : {}),
      ...(mode ? { mode } : {}),
      ...(requirement ? { requirement } : {}),
      stages,
    }
  }),
)

/**
 * 把时间格式化为本地 HH:mm，便于轨道下方紧凑展示。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无法解析时返回原值
 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 节点点击：按节点类型分发跳转，不做任何写操作。
 * 只对 target 为 true 的节点生效——空态节点渲染成静态元素，这里再多一道拦截，
 * 避免将来把空节点改回按钮时又出现「能点但没反应」。
 * @param row 当前工作区行
 * @param stage 被点击的节点
 */
function onStageClick(row: FlowRow, stage: FlowStage): void {
  if (!stage.target) return
  if (stage.key === 'story' && row.requirement) {
    emit('open-story', row.requirement)
    return
  }
  if (stage.key === 'cron') emit('go-crons')
}

/** 节点图标映射，与工作区/Story/定时三个阶段一一对应 */
const stageIcons = { workspace: FolderOpened, story: Document, cron: Timer }

/** Harness 阶段刻度：P0 到 P6 */
const phaseTicks = [0, 1, 2, 3, 4, 5, 6]
</script>

<template>
  <div class="flow-board">
    <article
      v-for="row in rows"
      :key="row.key"
      class="flow-card"
      :class="{ 'is-active': row.active }"
    >
      <header class="flow-card-head">
        <div class="flow-card-title">
          <span class="flow-ws-name">{{ row.name }}</span>
          <code class="flow-ws-path">{{ row.path }}</code>
        </div>
        <div class="flow-card-tags">
          <span class="flow-project">{{ row.projectLabel }}</span>
          <span v-if="row.branch" class="flow-branch"
            ><code>{{ row.branch }}</code></span
          >
          <span v-if="row.active" class="flow-live"><i />流程活跃</span>
          <span v-if="row.storyCandidates > 1" class="flow-warn"
            >检测到 {{ row.storyCandidates }} 份 Story</span
          >
        </div>
      </header>

      <div class="flow-track">
        <template v-for="(stage, index) in row.stages" :key="stage.key">
          <!-- 有目标对象的节点才是按钮；空态节点退成静态读数，不进 Tab 顺序、不给手形光标 -->
          <component
            :is="stage.target ? 'button' : 'div'"
            class="flow-node"
            :class="[`tone-${stage.tone}`, { 'is-clickable': stage.target }]"
            v-bind="stage.target ? { type: 'button' } : {}"
            @click="onStageClick(row, stage)"
          >
            <span class="flow-dot"><component :is="stageIcons[stage.key]" /></span>
            <span class="flow-label">{{ stage.label }}</span>
            <span class="flow-value">{{ stage.value }}</span>
            <span class="flow-hint">{{ stage.hint }}</span>
          </component>
          <span
            v-if="index < row.stages.length - 1"
            class="flow-link"
            :class="`tone-${stage.tone}`"
          />
        </template>
      </div>

      <footer class="flow-card-foot">
        <span class="flow-story-title" :title="row.title">{{ row.title }}</span>
        <span v-if="row.storyId" class="flow-story-id"
          ><code>{{ row.storyId }}</code></span
        >
        <div
          v-if="row.phase !== undefined"
          class="flow-phase"
          role="img"
          :aria-label="`Harness 阶段 ${phaseTag(row.phase, row.mode)}，共 7 档已通过 ${row.phase + 1} 档`"
          :title="`Harness 阶段 ${phaseTag(row.phase, row.mode)} / P6 构建部署`"
        >
          <span
            v-for="tick in phaseTicks"
            :key="tick"
            class="flow-tick"
            :class="{ 'is-passed': tick <= (row.phase ?? -1) }"
            aria-hidden="true"
          />
        </div>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.flow-board {
  display: grid;
  gap: 18px;
}
.flow-card {
  position: relative;
  overflow: hidden;
  padding: 18px 20px 14px;
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s ease;
}
/* 悬停只抬描边：DESIGN.md 规定 Contact 阴影不承担层级，状态变化只用颜色与描边 */
.flow-card:hover {
  border-color: var(--line-strong);
}
.flow-card.is-active {
  border-color: color-mix(in oklch, var(--warning) 45%, var(--line));
  background: color-mix(in oklch, var(--warning-soft) 25%, var(--surface));
}
.flow-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}
.flow-card-title {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.flow-ws-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.flow-ws-path {
  overflow: hidden;
  max-width: 100%;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-card-tags {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.flow-project {
  color: var(--text-muted);
  font-size: 11px;
}

.flow-branch code {
  color: var(--text-muted);
  font-size: 10px;
}
.flow-live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--warning);
  font-size: 11px;
}
/* 活跃点只呼吸透明度：DESIGN.md 禁止缩放手势类动效，状态还要靠文字「流程活跃」同现 */
.flow-live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  animation: flow-pulse 1.6s ease-in-out infinite;
}
.flow-warn {
  color: var(--warning);
  font-size: 11px;
}
@keyframes flow-pulse {
  50% {
    opacity: 0.35;
  }
}

.flow-track {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 22px 4px 6px;
}
.flow-node {
  display: grid;
  /*
   * 节点宽度按容器收缩：三段轨道在宽屏各占 124px，容器不够时按「(宽 - 2 段连线) / 3」等比变窄。
   * 124px 是设计宽度，不是硬下限：min-width 留 0，容器再窄时节点继续压缩（标签与读数单行省略），
   * 由 940px 断点接管纵向排布。若把 min-width 锁在 124px，轨道会在窄屏下横向溢出。
   */
  flex: 1 1 124px;
  min-width: 0;
  max-width: 124px;
  justify-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-muted);
  font: inherit;
  text-align: center;
}
.flow-node.is-clickable {
  cursor: pointer;
}
/*
 * 节点圆盘不带描边：状态改由底色与图标色承担，形状只保留「实心 / 空心」两档，
 * 这样它看起来是一枚指示灯，而不是一个带边框的按钮。
 */
.flow-dot {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  color: var(--text-faint);
  font-size: 15px;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}
.flow-label {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
}
.flow-value {
  overflow: hidden;
  max-width: 100%;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-hint {
  overflow: hidden;
  max-width: 100%;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 空态节点：没有可跳转对象，所以它既不悬停发亮，也不把手形光标给出去。
 * 只把图标描边换成虚线、文字压到弱一档，让「这里没有东西」读起来是状态、不是故障。
 */
/*
 * 空态：空心盘 —— 1px inset 阴影画出内圈，位置在 padding box 内侧，等效于「向内缩 1px 的描边」，
 * 与实心的「有数据」盘形成形状差异，同时不占用 .flow-dot 的 border（节点圆盘整体不带边框）。
 * 用选择器提高优先级，压过下方 .tone-* 的实心底色。
 */
.flow-node:not(.is-clickable) .flow-value {
  color: var(--text-muted);
  font-weight: 500;
}
.flow-node:not(.is-clickable) .flow-hint {
  color: var(--text-muted);
}
.flow-node.is-clickable:focus-visible {
  outline: none;
}
.flow-node.is-clickable:focus-visible .flow-dot {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

/* 连线：已走完的段用状态色，未到与空态段用 --text-faint 描线，卡片底上对比约 4.0:1（--line-strong 只有 2.0:1，太弱） */
.flow-link {
  flex: 1 1 auto;
  min-width: 18px;
  height: 2px;
  margin-top: 20px;
  border-radius: var(--radius-xs);
  background: var(--text-faint);
}
/* 连线只用实色：通过的段用状态色，未到的段保持发丝线，不写渐变 */
.flow-link.tone-ready {
  background: var(--success);
}
.flow-link.tone-active {
  background: var(--warning);
}
.flow-link.tone-danger {
  background: var(--danger);
}

.flow-card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}
.flow-story-title {
  overflow: hidden;
  min-width: 0;
  flex: 1 1 auto;
  color: var(--text);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-story-id code {
  color: var(--text-faint);
  font-size: 10px;
}
.flow-phase {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  margin-left: auto;
}
/*
 * 阶段刻度用「重量」而不是只用颜色区分两种状态：
 * 已通过是实心 4px 条，未通过是 1px 空心描边 —— 即使去掉颜色，形状差异依然成立。
 */
.flow-tick {
  width: 18px;
  height: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: transparent;
}
.flow-tick.is-passed {
  border-color: var(--success);
  background: var(--success);
}
/*
 * 940px：侧栏 216px 之后留给轨道的宽度已压到五段 124px 的实测下限，
 * 再横排就会开始截断读数，因此从这里起改为纵向节点列。
 */
@media (max-width: 940px) {
  .flow-track {
    flex-direction: column;
    gap: 10px;
  }
  .flow-node {
    flex: 0 0 auto;
    width: 100%;
    max-width: none;
    min-width: 0;
    grid-template-columns: 38px 1fr;
    justify-items: start;
    column-gap: 10px;
    text-align: left;
  }
  .flow-dot {
    grid-row: span 3;
  }
  .flow-link {
    width: 2px;
    height: 14px;
    min-width: 0;
    margin: 0 0 0 20px;
    background: var(--line);
  }
  .flow-story-title {
    max-width: 100%;
  }
}
</style>
