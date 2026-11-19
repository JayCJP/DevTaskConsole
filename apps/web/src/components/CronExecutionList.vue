<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CronExecution } from '@devtask/shared'
import { formatTime } from '../utils/format-time'

const props = defineProps<{
  /** 执行记录 */
  executions: CronExecution[]
  /** 加载中 */
  loading: boolean
  /** 错误信息 */
  error: string
  /** 数据来源 */
  source: 'api' | 'file'
  /** 兜底告警 */
  warning: string
  /** 是否还有下一页 */
  hasMore: boolean
}>()

const emit = defineEmits<{
  /** 重新按条件加载 */
  filter: [payload: { status?: 'queued' | 'running' | 'succeeded' | 'failed'; query?: string }]
  /** 加载下一页 */
  more: []
  /** 复制失败详情 */
  copy: [text: string]
}>()

/** 状态过滤选择值 */
const statusFilter = ref<'' | 'queued' | 'running' | 'succeeded' | 'failed'>('')
/** 关键词 */
const keyword = ref('')

/** 来源标记文案 */
const sourceLabel = computed(() => (props.source === 'api' ? '实时数据' : '离线数据（本地文件）'))

/** 是否存在记录 */
const isEmpty = computed(() => !props.loading && props.executions.length === 0)

/** 过滤条件是否为空 */
const canFilter = computed(() => statusFilter.value !== '' || keyword.value.trim().length > 0)

/**
 * 触发按条件重新加载。
 */
function applyFilter(): void {
  emit('filter', {
    ...(statusFilter.value ? { status: statusFilter.value } : {}),
    ...(keyword.value.trim() ? { query: keyword.value.trim() } : {}),
  })
}

/**
 * 清空过滤条件并重新加载。
 */
function clearFilter(): void {
  statusFilter.value = ''
  keyword.value = ''
  emit('filter', {})
}

/**
 * 状态徽标样式。
 * @param status 执行状态
 * @returns 样式类名
 */
function statusClass(status: CronExecution['status']): string {
  if (status === 'succeeded') return 'tag-success'
  if (status === 'failed') return 'tag-danger'
  if (status === 'running') return 'tag-warning'
  return ''
}

/**
 * 状态中文文案。
 * @param status 执行状态
 * @returns 中文文案
 */
function statusLabel(status: CronExecution['status']): string {
  if (status === 'succeeded') return '成功'
  if (status === 'failed') return '失败'
  if (status === 'running') return '运行中'
  return '排队中'
}

/**
 * 计算耗时文本。
 * @param execution 执行记录
 * @returns 耗时文本；缺少结束时间时返回占位
 */
function durationText(execution: CronExecution): string {
  if (!execution.finishedAt) return '进行中'
  const milliseconds =
    new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知'
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} 秒`
  return `${Math.round(milliseconds / 60_000)} 分钟`
}
</script>

<template>
  <div class="cron-executions">
    <div class="cron-executions-head">
      <strong>执行记录</strong>
      <span class="tag" :class="props.source === 'api' ? 'tag-success' : 'tag-warning'">{{
        sourceLabel
      }}</span>
      <span class="cron-executions-count">{{ props.executions.length }} 条</span>
    </div>
    <p v-if="props.warning" class="cron-executions-warning" role="status">{{ props.warning }}</p>

    <div class="cron-executions-filter">
      <el-select v-model="statusFilter" size="small" placeholder="全部状态" clearable>
        <el-option label="排队中" value="queued" />
        <el-option label="运行中" value="running" />
        <el-option label="成功" value="succeeded" />
        <el-option label="失败" value="failed" />
      </el-select>
      <el-input
        v-model="keyword"
        size="small"
        placeholder="匹配 runId / 错误"
        clearable
        @keyup.enter="applyFilter"
      />
      <el-button size="small" type="primary" plain :disabled="!canFilter" @click="applyFilter"
        >筛选</el-button
      >
      <el-button size="small" :disabled="!canFilter" @click="clearFilter">清空</el-button>
    </div>

    <p v-if="props.error" class="mapping-error" role="alert">{{ props.error }}</p>
    <div v-if="props.loading && !props.executions.length" class="empty-compact">
      正在读取执行记录…
    </div>
    <ol v-else-if="!isEmpty" class="cron-timeline">
      <li v-for="execution in props.executions" :key="execution.id" class="cron-timeline-item">
        <span
          class="status-dot"
          :class="
            execution.status === 'running'
              ? 'is-active'
              : execution.status === 'failed'
                ? 'is-error'
                : ''
          "
        />
        <div class="cron-timeline-body">
          <div class="cron-timeline-line">
            <span class="tag" :class="statusClass(execution.status)">{{
              statusLabel(execution.status)
            }}</span>
            <strong>{{ formatTime(execution.startedAt) }}</strong>
            <small>耗时 {{ durationText(execution) }}</small>
            <small v-if="execution.runId" class="cron-run-id">
              runId {{ execution.runId }}
              <el-button link type="primary" size="small" @click="emit('copy', execution.runId)"
                >复制</el-button
              >
            </small>
          </div>
          <p v-if="execution.error" class="cron-timeline-error">{{ execution.error }}</p>
        </div>
      </li>
    </ol>
    <div v-else class="empty-compact">该任务还没有执行记录。</div>

    <el-button v-if="props.hasMore" size="small" :loading="props.loading" @click="emit('more')"
      >加载更多</el-button
    >
  </div>
</template>
