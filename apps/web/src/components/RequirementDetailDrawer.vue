<script setup lang="ts">
/**
 * 需求详情抽屉。
 * 展示单个 TAPD 需求的阶段、处理人、工作区及关联缺陷/修复记录/待确认项。
 * 由壳层持有选中需求状态，故抽屉可跨页面保持打开（例如从看板打开后切到实例页）。
 */
import type { Requirement } from '@devtask/shared'
import type { Snapshot } from '@devtask/shared'

/** 关联缺陷条目 */
type Bug = Snapshot['bugs'][number]
/** Harness 修复记录条目 */
type HarnessBug = Snapshot['harnessBugs'][number]
/** 待确认项条目 */
type OpenQuestion = Snapshot['openQuestions'][number]

const props = defineProps<{
  /** 选中的需求，为空时抽屉不渲染内容 */
  requirement: Requirement | null
  /** 抽屉开关（v-model） */
  modelValue: boolean
  /** 关联缺陷 */
  bugs: Bug[]
  /** Harness 修复记录 */
  harnessBugs: HarnessBug[]
  /** 需求待确认项 */
  questions: OpenQuestion[]
  /** TAPD 通道是否可用，决定缺陷区空态文案 */
  tapdAvailable: boolean
}>()

const emit = defineEmits<{
  /** 更新抽屉开关 */
  'update:modelValue': [value: boolean]
}>()

/**
 * 关闭抽屉：清空选中需求并同步 v-model。
 */
function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    title="需求详情"
    size="min(560px, 94vw)"
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    @update:model-value="emit('update:modelValue', $event)"
    @close="close"
  >
    <template v-if="props.requirement">
      <p class="eyebrow">{{ props.requirement.storyId }}</p><h2>{{ props.requirement.title }}</h2>
      <div class="detail-grid"><span>阶段</span><strong>{{ props.requirement.phase === undefined ? '未知' : `Phase ${props.requirement.phase}` }}</strong><span>处理人</span><strong>{{ props.requirement.owner || '未分配' }}</strong><span>工作区</span><code>{{ props.requirement.workspacePath || '未关联' }}</code><span>Bug</span><strong>new {{ props.requirement.bugNew ?? 0 }} · reopened {{ props.requirement.bugReopened ?? 0 }}</strong></div>
      <section class="bug-detail-list">
        <h3>关联缺陷</h3>
        <article v-for="bug in props.bugs" :key="bug.id" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ bug.title || `Bug ${bug.id}` }}</strong><span class="tag" :class="bug.status === 'reopened' ? 'tag-danger' : 'tag-warning'">{{ bug.status }}{{ bug.status === 'reopened' ? ' · 需读评论' : '' }}</span></div>
          <p>{{ bug.currentOwner }}<span v-if="bug.module"> · {{ bug.module }}</span><span v-if="bug.created"> · {{ bug.created }}</span></p>
          <p v-if="bug.description">{{ bug.description }}</p>
        </article>
        <p v-if="!props.bugs.length" class="muted">{{ props.tapdAvailable ? '没有符合当前处理人口径的新建或重开缺陷。' : 'TAPD 数据不可用；请先检查连接状态。' }}</p>
      </section>
      <section v-if="props.harnessBugs.length" class="bug-detail-list">
        <h3>Harness 修复记录</h3>
        <article v-for="bug in props.harnessBugs" :key="bug.bugId" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ bug.title }}</strong><span class="tag" :class="bug.status === 'reopened' ? 'tag-danger' : ''">{{ bug.bugId }} · {{ bug.status }}{{ bug.category ? ` · ${bug.category}` : '' }}</span></div>
          <p v-if="bug.commentDigest">{{ bug.commentDigest }}</p>
          <p v-if="bug.writeback">回写 {{ bug.writeback.commentKind }} · {{ bug.writeback.commentedAt }}</p>
        </article>
      </section>
      <section v-if="props.questions.length" class="bug-detail-list">
        <h3>需求待确认项</h3>
        <article v-for="question in props.questions" :key="question.id" class="bug-detail">
          <div class="inbox-title-line"><strong>{{ question.id }} · {{ question.question }}</strong><span class="tag" :class="question.state === 'pending_confirmation' || question.state === 'no_proposal' ? 'tag-warning' : ''">{{ question.state }}</span></div>
          <p v-if="question.resolution">建议稿：{{ question.resolution }}</p>
          <p v-if="question.state === 'pending_confirmation' || question.state === 'no_proposal'">本站只展示，不会代替用户写入确认或推进 Harness。</p>
        </article>
      </section>
      <p class="muted">此处只展示各数据源状态；流程推进与状态写入由对应源系统负责。</p>
    </template>
    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-drawer>
</template>
