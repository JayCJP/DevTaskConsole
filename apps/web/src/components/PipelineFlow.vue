<script setup lang="ts">
import { computed } from 'vue'
import { Document, FolderOpened, Promotion, Share, Timer } from '@element-plus/icons-vue'
import type { Build, MergeRequest, Requirement, WorkspacePipeline } from '@devtask/shared'

/**
 * 流水线可视化：一个工作区一条水平轨道，节点依次为 工作区 → Story → MR → 构建 → 定时。
 * 只读展示源系统状态；节点点击只做跳转，不推进流程。
 */
const props = defineProps<{ pipelines: WorkspacePipeline[] }>()

const emit = defineEmits<{
  (event: 'open-story', requirement: Requirement): void
  (event: 'open-merge-request', mergeRequest: MergeRequest): void
  (event: 'open-build', build: Build): void
  (event: 'go-crons'): void
}>()

/** 节点状态色：ready=有数据，active=正在流转，empty=暂无，danger=失败 */
type StageTone = 'ready' | 'active' | 'empty' | 'danger'

interface FlowStage {
  key: 'workspace' | 'story' | 'mr' | 'build' | 'cron'
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
  requirement?: Requirement
  mergeRequest?: MergeRequest
  build?: Build
  stages: FlowStage[]
}

const rows = computed<FlowRow[]>(() => props.pipelines.map((pipeline) => {
  const story = pipeline.story
  const requirement = story?.requirement
  // MR 数量与可点击的 MR 必须来自同一来源，否则会出现「0 个 MR 却能点进去」的矛盾展示
  const storyMergeRequests = story?.mergeRequests ?? pipeline.mergeRequests
  const mergeRequest = storyMergeRequests[0]
  const build = pipeline.builds[0]
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
      value: requirement ? `P${requirement.phase ?? '—'}` : '—',
      hint: requirement ? requirement.storyId : '等待 plans',
      tone: story ? (story.harnessActive ? 'active' : 'ready') : 'empty',
      target: Boolean(requirement),
    },
    {
      key: 'mr',
      label: '合并请求',
      // 同理：没有 MR 数据时不写 0，避免「一个都没有」与「没查」混在一起
      value: mergeRequest ? String(storyMergeRequests.length) : '—',
      hint: mergeRequestHint(mergeRequest),
      tone: storyMergeRequests.length ? 'ready' : 'empty',
      target: Boolean(mergeRequest),
    },
    {
      key: 'build',
      label: '构建',
      // 没有构建数据时不给数字：显示 0 会被读成「构建了 0 次」，与「拿不到数据」混为一谈
      value: build ? String(pipeline.builds.length) : '—',
      hint: buildHint(build),
      tone: build ? (build.succeed === false ? 'danger' : build.succeed ? 'ready' : 'active') : 'empty',
      target: Boolean(build),
    },
    {
      key: 'cron',
      label: '定时',
      value: String(pipeline.crons.length),
      hint: nextRun ? `下次 ${formatTime(nextRun)}` : pipeline.crons.length ? '已配置' : '暂无任务',
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
    ...(requirement ? { requirement } : {}),
    ...(mergeRequest ? { mergeRequest } : {}),
    ...(build ? { build } : {}),
    stages,
  }
}))

/** 合并请求状态的中文映射；未收录的状态回落到原文，并交给调用方补「未知」提示 */
const mergeRequestStateLabels: Record<string, string> = {
  opened: '待合并',
  merged: '已合并',
  closed: '已关闭',
  locked: '已锁定',
}

/**
 * 合并请求节点的副标题：把上游英文枚举翻成产品的中文术语。
 * @param mergeRequest 最新一条 MR；没有 MR 时为 undefined
 * @returns 中文状态或「暂无 MR」；未收录状态原样返回
 */
function mergeRequestHint(mergeRequest: MergeRequest | undefined): string {
  if (!mergeRequest) return '暂无 MR'
  return mergeRequestStateLabels[mergeRequest.state] ?? mergeRequest.state
}

/**
 * 构建节点的副标题：区分「没有构建记录」与「有记录但还在跑」。
 * @param build 最近一条构建记录；undefined 表示这个工作区还没有构建数据
 * @returns 描述文本
 */
function buildHint(build: Build | undefined): string {
  if (!build) return '没有构建记录'
  if (build.succeed === null) return '运行中'
  return build.succeed ? '最近成功' : '最近失败'
}

/**
 * 把时间格式化为本地 HH:mm，便于轨道下方紧凑展示。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无法解析时返回原值
 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  if (stage.key === 'mr' && row.mergeRequest) {
    emit('open-merge-request', row.mergeRequest)
    return
  }
  if (stage.key === 'build' && row.build) {
    emit('open-build', row.build)
    return
  }
  if (stage.key === 'cron') emit('go-crons')
}

/** 节点图标映射，与工作区/Story/MR/构建/定时五个阶段一一对应 */
const stageIcons = { workspace: FolderOpened, story: Document, mr: Share, build: Promotion, cron: Timer }

/** Harness 阶段刻度：P0 到 P6 */
const phaseTicks = [0, 1, 2, 3, 4, 5, 6]
</script>

<template>
  <div class="flow-board">
    <article v-for="row in rows" :key="row.key" class="flow-card" :class="{ 'is-active': row.active }">
      <header class="flow-card-head">
        <div class="flow-card-title">
          <span class="flow-ws-name">{{ row.name }}</span>
          <code class="flow-ws-path">{{ row.path }}</code>
        </div>
        <div class="flow-card-tags">
          <span class="flow-project">{{ row.projectLabel }}</span>
          <span v-if="row.branch" class="flow-branch"><code>{{ row.branch }}</code></span>
          <span v-if="row.active" class="flow-live"><i />流程活跃</span>
          <span v-if="row.storyCandidates > 1" class="flow-warn">检测到 {{ row.storyCandidates }} 份 Story</span>
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
          <span v-if="index < row.stages.length - 1" class="flow-link" :class="`tone-${stage.tone}`" />
        </template>
      </div>

      <footer class="flow-card-foot">
        <span class="flow-story-title" :title="row.title">{{ row.title }}</span>
        <span v-if="row.storyId" class="flow-story-id"><code>{{ row.storyId }}</code></span>
        <div
          v-if="row.phase !== undefined"
          class="flow-phase"
          role="img"
          :aria-label="`Harness 阶段 P${row.phase}，共 7 档已通过 ${row.phase + 1} 档`"
          :title="`Harness 阶段 P${row.phase} / P6`"
        >
          <span v-for="tick in phaseTicks" :key="tick" class="flow-tick" :class="{ 'is-passed': tick <= (row.phase ?? -1) }" aria-hidden="true" />
        </div>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.flow-board { display: grid; gap: 18px; }
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
.flow-card:hover { border-color: var(--line-strong); }
.flow-card.is-active {
  border-color: color-mix(in oklch, var(--warning) 45%, var(--line));
  background: color-mix(in oklch, var(--warning-soft) 25%, var(--surface));
}
.flow-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.flow-card-title { display: grid; gap: 2px; min-width: 0; }
.flow-ws-name { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.flow-ws-path { overflow: hidden; max-width: 100%; color: var(--text-faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.flow-card-tags { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.flow-project { color: var(--text-muted); font-size: 11px; }

.flow-branch code { color: var(--text-muted); font-size: 10px; }
.flow-live { display: inline-flex; align-items: center; gap: 5px; color: var(--warning); font-size: 11px; }
/* 活跃点只呼吸透明度：DESIGN.md 禁止缩放手势类动效，状态还要靠文字「流程活跃」同现 */
.flow-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); animation: flow-pulse 1.6s ease-in-out infinite; }
.flow-warn { color: var(--warning); font-size: 11px; }
@keyframes flow-pulse { 50% { opacity: 0.35; } }

.flow-track { display: flex; align-items: flex-start; gap: 4px; padding: 22px 4px 6px; }
.flow-node {
  display: grid;
  /*
   * 节点宽度按容器收缩：五段轨道在宽屏各占 124px，容器不够时按「(宽 - 4 段连线) / 5」等比变窄。
   * 124px 是设计宽度，不是硬下限：min-width 留 0，容器再窄时节点继续压缩（标签与读数单行省略），
   * 由 940px 断点接管纵向排布。若把 min-width 锁在 124px，五段轨道会在 960–1100px 之间横向溢出。
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
.flow-node.is-clickable { cursor: pointer; }
/*
 * 节点圆盘不带描边：状态改由底色与图标色承担，形状只保留「实心 / 空心」两档，
 * 这样它看起来是一枚指示灯，而不是一个带边框的按钮。
 */
.flow-dot {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
  font-size: 15px;
  transition: background-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}
.flow-label { color: var(--text-muted); font-size: 11px; letter-spacing: 0.06em; }
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
.flow-hint { overflow: hidden; max-width: 100%; color: var(--text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
/*
 * 空态节点：没有可跳转对象，所以它既不悬停发亮，也不把手形光标给出去。
 * 只把图标描边换成虚线、文字压到弱一档，让「这里没有东西」读起来是状态、不是故障。
 */
/*
 * 空态：空心盘 —— 1px inset 阴影画出内圈，位置在 padding box 内侧，等效于「向内缩 1px 的描边」，
 * 与实心的「有数据」盘形成形状差异，同时不占用 .flow-dot 的 border（节点圆盘整体不带边框）。
 * 用选择器提高优先级，压过下方 .tone-* 的实心底色。
 */
.flow-node:not(.is-clickable) .flow-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--text-faint); box-sizing: border-box; }
.flow-node:not(.is-clickable) .flow-value { color: var(--text-muted); font-weight: 500; }
.flow-node:not(.is-clickable) .flow-hint { color: var(--text-muted); }
.flow-node.is-clickable:hover .flow-dot { background: var(--brand-soft); color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.flow-node.is-clickable:focus-visible { outline: none; }
.flow-node.is-clickable:focus-visible .flow-dot { outline: 2px solid var(--brand); outline-offset: 2px; }

/* 有数据的节点：实心盘 + 状态色图标；底色用对应状态色的极淡档，不再靠描边宣告状态 */
/* 实心盘 + 状态色图标：底色只抬一档（--bg-raised），状态信息放在图标与文字上 */
.tone-ready .flow-dot { background: var(--bg-raised); color: var(--success); }
.tone-active .flow-dot { background: var(--bg-raised); color: var(--warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 14%, transparent); }
.tone-danger .flow-dot { background: var(--bg-raised); color: var(--danger); }
/* 连线：已走完的段用状态色，未到与空态段用 --text-faint 描线，卡片底上对比约 4.0:1（--line-strong 只有 2.0:1，太弱） */
.flow-link { flex: 1 1 auto; min-width: 18px; height: 2px; margin-top: 20px; border-radius: var(--radius-xs); background: var(--text-faint); }
/* 连线只用实色：通过的段用状态色，未到的段保持发丝线，不写渐变 */
.flow-link.tone-ready { background: var(--success); }
.flow-link.tone-active { background: var(--warning); }
.flow-link.tone-danger { background: var(--danger); }

.flow-card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px dashed var(--line); }
.flow-story-title { overflow: hidden; min-width: 0; flex: 1 1 auto; color: var(--text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.flow-story-id code { color: var(--text-faint); font-size: 10px; }
.flow-phase { display: flex; flex: 0 0 auto; gap: 4px; margin-left: auto; }
/*
 * 阶段刻度用「重量」而不是只用颜色区分两种状态：
 * 已通过是实心 4px 条，未通过是 1px 空心描边 —— 即使去掉颜色，形状差异依然成立。
 */
.flow-tick { width: 18px; height: 4px; border: 1px solid var(--line-strong); border-radius: var(--radius-xs); background: transparent; }
.flow-tick.is-passed { border-color: var(--success); background: var(--success); }
/*
 * 940px：侧栏 216px 之后留给轨道的宽度已压到五段 124px 的实测下限，
 * 再横排就会开始截断读数，因此从这里起改为纵向节点列。
 */
@media (max-width: 940px) {
  .flow-track { flex-direction: column; gap: 10px; }
  .flow-node { flex: 0 0 auto; width: 100%; max-width: none; min-width: 0; grid-template-columns: 38px 1fr; justify-items: start; column-gap: 10px; text-align: left; }
  .flow-dot { grid-row: span 3; }
  .flow-link { width: 2px; height: 14px; min-width: 0; margin: 0 0 0 20px; background: var(--line); }
  .flow-story-title { max-width: 100%; }
}
</style>
