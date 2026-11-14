<script setup lang="ts">
import { computed } from 'vue'
import type { StoryServiceInfo } from '../composables/useServiceLifecycle'

const props = defineProps<{
  /** Story 标识 */
  storyId: string
  /** Story 标题 */
  title: string
  /** 工作区相对路径，仅作悬停提示，不占列表空间 */
  workspacePath?: string
  /** 服务登记；未登记时缺省 */
  service?: StoryServiceInfo
  /** 该 Story 下的实例数量 */
  jobCount: number
  /** 是否为右侧当前关注的 Story */
  active: boolean
  /** 最近一次服务操作的失败原因 */
  error?: string
}>()

const emit = defineEmits<{
  /** 把该 Story 设为右侧当前关注对象 */
  focus: []
}>()

/** 状态点样式 */
const dotClass = computed(() => {
  const status = props.service?.status
  if (status === 'running') return 'is-active'
  if (status === 'failed') return 'is-error'
  return ''
})

/** 状态中文文案 */
const statusLabel = computed(() => {
  const status = props.service?.status
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'failed') return '异常'
  if (status === 'stopped') return '已停止'
  return '未启动'
})

/** 状态徽标样式 */
const statusClass = computed(() => {
  const status = props.service?.status
  if (status === 'running') return 'tag-success'
  if (status === 'failed') return 'tag-danger'
  if (status === 'stopped') return ''
  return 'tag-warning'
})

/** 副标题：端口与实例数，长路径收进 title 悬停提示 */
const subtitle = computed(() => {
  const port = props.service?.port ? `端口 ${props.service.port}` : '端口未分配'
  return `${port} · ${props.jobCount} 个实例`
})

/** 悬停提示：完整 Story 与工作区路径 */
const tooltip = computed(() => `${props.storyId}${props.workspacePath ? ` · ${props.workspacePath}` : ''}`)
</script>

<template>
  <article class="instance-story" :class="{ 'is-current': props.active }">
    <button
      type="button"
      class="instance-story-button"
      :aria-pressed="props.active"
      :title="tooltip"
      @click="emit('focus')"
    >
      <span class="status-dot" :class="dotClass" :aria-label="`服务状态：${statusLabel}`" />
      <span class="instance-story-text">
        <strong>{{ props.title }}</strong>
        <small>{{ subtitle }}</small>
      </span>
      <span class="tag" :class="statusClass">{{ statusLabel }}</span>
    </button>
    <p v-if="props.error" class="mapping-error" role="alert">{{ props.error }}</p>
  </article>
</template>
