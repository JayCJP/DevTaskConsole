<script setup lang="ts">
import type { AuditEntry } from '@devtask/shared'

const props = defineProps<{
  /** 抽屉开关 */
  modelValue: boolean
  /** 审计条目 */
  entries: AuditEntry[]
  /** 加载中 */
  loading: boolean
  /** 错误信息 */
  error: string
  /** 正在撤销的条目 ID */
  undoingId: string | null
}>()

const emit = defineEmits<{
  /** 更新抽屉开关 */
  'update:modelValue': [value: boolean]
  /** 刷新流水 */
  refresh: []
  /** 撤销条目 */
  undo: [id: string]
}>()

/**
 * 动作的中文文案。
 * @param action 动作标识
 * @returns 中文文案
 */
function actionLabel(action: AuditEntry['action']): string {
  const labels: Record<AuditEntry['action'], string> = {
    'cron.create': '创建定时任务',
    'cron.update': '修改调度规则',
    'cron.toggle': '启用/暂停任务',
    'cron.delete': '删除定时任务',
    'cron.renew': '续期定时任务',
    'cron.owner': '保存 owner 映射',
    'cron.dispatch': '派发轮次',
    'cron.dispatch.archive': '归档派发轮次',
    'cron.executions.delete': '删除执行记录',
    'service.stop': '停止服务',
    'service.remove': '删除服务映射',
    'workspace.initialize.resume': '续跑初始化',
    'build.trigger': '触发构建',
    'story.create': '新建 Story 骨架',
  }
  return labels[action]
}

/**
 * 判断条目当前是否可撤销。
 * @param entry 审计条目
 * @returns 可撤销返回 true
 */
function canUndo(entry: AuditEntry): boolean {
  return entry.reversible && !entry.undone && entry.result === 'succeeded'
}

/**
 * 不可撤销的原因说明。
 * @param entry 审计条目
 * @returns 原因文案
 */
function undoHint(entry: AuditEntry): string {
  if (entry.undone) return '已撤销'
  if (!entry.reversible) return '该动作不可撤销'
  if (entry.result !== 'succeeded') return '动作未生效，无需撤销'
  return ''
}
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    title="操作审计"
    size="min(680px, 96vw)"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="audit-head">
      <p class="muted">记录本站发起的写操作；删除任务、停止服务等动作不可撤销。</p>
      <el-button size="small" :loading="props.loading" @click="emit('refresh')">刷新</el-button>
    </div>
    <p v-if="props.error" class="mapping-error" role="alert">{{ props.error }}</p>
    <div v-if="props.loading && !props.entries.length" class="empty-compact">正在读取审计流水…</div>
    <ol v-else-if="props.entries.length" class="audit-list">
      <li v-for="entry in props.entries" :key="entry.id" class="audit-item" :class="{ 'is-undone': entry.undone }">
        <div class="audit-line">
          <span class="tag" :class="entry.result === 'failed' ? 'tag-danger' : 'tag-success'">
            {{ entry.result === 'failed' ? '失败' : '成功' }}
          </span>
          <strong>{{ actionLabel(entry.action) }}</strong>
          <code>{{ entry.target }}</code>
          <small>{{ new Date(entry.createdAt).toLocaleString() }}</small>
          <span class="audit-actions">
            <el-button
              v-if="canUndo(entry)"
              size="small"
              :loading="props.undoingId === entry.id"
              @click="emit('undo', entry.id)"
            >
              撤销
            </el-button>
            <small v-else class="muted">{{ undoHint(entry) }}</small>
          </span>
        </div>
        <small v-if="entry.storyId" class="muted">Story {{ entry.storyId }}</small>
        <p v-if="entry.error" class="audit-error">{{ entry.error }}</p>
        <p v-if="entry.after" class="audit-diff"><code>{{ JSON.stringify(entry.after) }}</code></p>
      </li>
    </ol>
    <div v-else class="empty-compact">还没有审计记录。</div>
  </el-drawer>
</template>
