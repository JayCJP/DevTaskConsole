<script setup lang="ts">
import type { Cron } from '@devtask/shared'

/** 定时任务 owner 映射草稿，由父页面维护 */
interface CronMappingDraft {
  storyId: string
  ownerSessionId: string
  mode: '' | 'query_only' | 'query_fix'
  saving: boolean
  error: string
}

const props = defineProps<{
  /** 单条定时任务事实（只读，来自工作区 scheduled_tasks.json） */
  cron: Cron
  /** 该任务的 owner 映射草稿；未初始化时保存按钮不可用 */
  draft?: CronMappingDraft
}>()

const emit = defineEmits<{
  /** 请求父页面保存 owner 映射，参数为任务 ID */
  save: [taskId: string]
}>()

/**
 * 任务模式的展示文案。
 * @param mode 任务模式
 * @returns 中文文案
 */
function modeLabel(mode: Cron['mode']): string {
  if (mode === 'query_fix') return '查询 + 修复'
  if (mode === 'query_only') return '只查询'
  return '模式待确认'
}

/**
 * 解析时间字段为本地可读文本。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；缺省时返回空串
 */
function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : ''
}
</script>

<template>
  <div class="cron-row">
    <div class="cron-primary">
      <strong>{{ props.cron.storyTitle || '未关联 Story' }}</strong>
      <small><code>{{ props.cron.id }}</code> · {{ props.cron.storyId || 'Story 未映射' }} · {{ modeLabel(props.cron.mode) }} · owner {{ props.cron.ownerSessionId || '未关联' }}</small>
      <small v-if="props.cron.promptFirstLine" class="cron-prompt-line">{{ props.cron.promptFirstLine }}</small>
      <small v-if="props.cron.mode === 'query_fix'" class="cron-risk">修复模式可能修改代码或写回 TAPD；当前控制台不触发 scheduled task。</small>
    </div>
    <code>{{ props.cron.cron }}</code>
    <span class="tag" :class="props.cron.enabled === true ? 'tag-success' : props.cron.enabled === false ? 'tag-warning' : ''">{{ props.cron.enabled === true ? '运行中' : props.cron.enabled === false ? '已暂停' : '状态未知' }}</span>
    <span>{{ formatTime(props.cron.nextRun) || '下次运行未知' }}</span>
    <span v-if="props.cron.expiresAt">到期 {{ new Date(props.cron.expiresAt).toLocaleDateString() }}</span>
    <div v-if="props.draft" class="cron-mapping">
      <span>{{ props.draft.storyId }} · {{ props.cron.storyTitle }}</span>
      <el-select v-model="props.draft.mode" placeholder="确认任务类型">
        <el-option label="只查询" value="query_only" />
        <el-option label="查询 + 修复" value="query_fix" />
      </el-select>
      <el-input v-model="props.draft.ownerSessionId" placeholder="专属 owner session ID" />
      <el-button type="primary" size="small" :loading="props.draft.saving" :disabled="!props.draft.ownerSessionId.trim() || !props.draft.mode" @click="emit('save', props.cron.id)">保存 owner 映射</el-button>
      <p v-if="props.draft.error" class="mapping-error" role="alert">{{ props.draft.error }}</p>
    </div>
  </div>
</template>
