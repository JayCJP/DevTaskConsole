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
    },
    {
      key: 'story',
      label: 'Story',
      value: requirement ? `P${requirement.phase ?? '—'}` : '—',
      hint: requirement ? requirement.storyId : '等待 plans',
      tone: story ? (story.harnessActive ? 'active' : 'ready') : 'empty',
    },
    {
      key: 'mr',
      label: '合并请求',
      value: String(storyMergeRequests.length),
      hint: mergeRequest ? mergeRequest.state : '暂无 MR',
      tone: storyMergeRequests.length ? 'ready' : 'empty',
    },
    {
      key: 'build',
      label: '构建',
      value: String(pipeline.builds.length),
      hint: buildHint(build),
      tone: build ? (build.succeed === false ? 'danger' : build.succeed ? 'ready' : 'active') : 'empty',
    },
    {
      key: 'cron',
      label: '定时',
      value: String(pipeline.crons.length),
      hint: nextRun ? `下次 ${formatTime(nextRun)}` : pipeline.crons.length ? '已配置' : '暂无任务',
      tone: pipeline.crons.length ? 'ready' : 'empty',
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

/**
 * 构建节点的副标题：展示最近一次构建的结果。
 * @param build 最近一条构建记录
 * @returns 描述文本
 */
function buildHint(build: Build | undefined): string {
  if (!build) return '暂无构建'
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
 * @param row 当前工作区行
 * @param stage 被点击的节点
 */
function onStageClick(row: FlowRow, stage: FlowStage): void {
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
          <button
            type="button"
            class="flow-node"
            :class="[`tone-${stage.tone}`, { 'is-clickable': stage.key !== 'workspace' }]"
            @click="onStageClick(row, stage)"
          >
            <span class="flow-dot"><component :is="stageIcons[stage.key]" /></span>
            <span class="flow-label">{{ stage.label }}</span>
            <span class="flow-value">{{ stage.value }}</span>
            <span class="flow-hint">{{ stage.hint }}</span>
          </button>
          <span v-if="index < row.stages.length - 1" class="flow-link" :class="`tone-${stage.tone}`" />
        </template>
      </div>

      <footer class="flow-card-foot">
        <span class="flow-story-title" :title="row.title">{{ row.title }}</span>
        <span v-if="row.storyId" class="flow-story-id"><code>{{ row.storyId }}</code></span>
        <div v-if="row.phase !== undefined" class="flow-phase" :title="`Harness 阶段 P${row.phase} / P6`">
          <span v-for="tick in phaseTicks" :key="tick" class="flow-tick" :class="{ 'is-passed': tick <= (row.phase ?? -1) }" />
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
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(160deg, var(--surface-raised) 0%, var(--surface) 62%);
  transition: border-color 0.25s ease, transform 0.25s ease;
}
.flow-card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); transform: translateY(-2px); }
.flow-card.is-active { border-color: color-mix(in srgb, var(--amber) 45%, var(--line)); }
.flow-card.is-active::before {
  position: absolute;
  inset: 0 auto auto 0;
  width: 3px;
  height: 100%;
  background: var(--amber);
  content: '';
}
.flow-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.flow-card-title { display: grid; gap: 2px; min-width: 0; }
.flow-ws-name { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.flow-ws-path { color: var(--faint); font-size: 10px; }
.flow-card-tags { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.flow-project { color: var(--muted); font-size: 11px; }

.flow-branch code { color: var(--muted); font-size: 10px; }
.flow-live { display: inline-flex; align-items: center; gap: 5px; color: var(--amber); font-size: 11px; }
.flow-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); animation: flow-pulse 1.6s ease-in-out infinite; }
.flow-warn { color: var(--amber); font-size: 11px; }
@keyframes flow-pulse { 50% { opacity: 0.25; transform: scale(0.7); } }

.flow-track { display: flex; align-items: flex-start; gap: 6px; padding: 22px 4px 6px; }
.flow-node {
  display: grid;
  flex: 0 0 auto;
  width: 118px;
  justify-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  text-align: center;
}
.flow-node.is-clickable { cursor: pointer; }
.flow-dot {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--surface);
  color: var(--faint);
  font-size: 17px;
  transition: box-shadow 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
.flow-label { color: var(--faint); font-size: 10px; letter-spacing: 0.08em; }
.flow-value {
  overflow: hidden;
  max-width: 100%;
  color: var(--text);
  font-family: 'IBM Plex Mono', 'Cascadia Code', monospace;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-hint { overflow: hidden; max-width: 100%; color: var(--faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.flow-node.is-clickable:hover .flow-dot { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }

.tone-ready .flow-dot { border-color: color-mix(in srgb, var(--green) 55%, var(--line)); color: var(--green); }
.tone-active .flow-dot { border-color: var(--amber); color: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 12%, transparent); }
.tone-danger .flow-dot { border-color: var(--red); color: var(--red); }
.flow-link { flex: 1 1 auto; min-width: 18px; height: 2px; margin-top: 20px; border-radius: 2px; background: var(--line); }
.flow-link.tone-ready { background: linear-gradient(90deg, color-mix(in srgb, var(--green) 60%, var(--line)), var(--line)); }
.flow-link.tone-active { background: linear-gradient(90deg, var(--amber), var(--line)); }
.flow-link.tone-danger { background: linear-gradient(90deg, var(--red), var(--line)); }

.flow-card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px dashed var(--line); }
.flow-story-title { overflow: hidden; max-width: 62%; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.flow-story-id code { color: var(--faint); font-size: 10px; }
.flow-phase { display: flex; gap: 4px; margin-left: auto; }
.flow-tick { width: 18px; height: 4px; border-radius: 2px; background: var(--line); }
.flow-tick.is-passed { background: var(--green); }

@media (max-width: 900px) {
  .flow-track { flex-direction: column; gap: 10px; }
  .flow-node { width: 100%; grid-template-columns: 38px 1fr; justify-items: start; column-gap: 10px; text-align: left; }
  .flow-dot { grid-row: span 3; }
  .flow-link { width: 2px; height: 14px; min-width: 0; margin: 0 0 0 20px; background: var(--line); }
  .flow-story-title { max-width: 100%; }
}
</style>
