<script setup lang="ts">
/**
 * 操作结果提示条组件。
 * 承载两类提示：实例写操作的成功/失败 toast，以及定时任务动作的撤销提示。
 * 两者共用同一容器，保证「不打断流程、超时自动消失」的既有交互。
 */
import type { ActionToast } from '../composables/useActionToasts'
import type { CronUndoNotice } from '../composables/useCronActions'

const props = defineProps<{
  /** 操作结果提示列表 */
  actionToastItems: ActionToast[]
  /** 定时任务撤销提示列表 */
  cronNotices: CronUndoNotice[]
}>()

const emit = defineEmits<{
  /** 关闭一条操作结果提示 */
  dismissActionToast: [id: string]
  /** 撤销一条定时任务动作 */
  undoCronAction: [auditId: string]
  /** 关闭一条撤销提示 */
  dismissCronNotice: [id: string]
}>()
</script>

<template>
  <!-- 撤销提示条：不打断流程，超时自动消失 -->
  <div v-if="props.cronNotices.length || props.actionToastItems.length" class="undo-toasts" role="status">
    <div
      v-for="toast in props.actionToastItems"
      :key="toast.id"
      class="undo-toast"
      :class="toast.kind === 'error' ? 'is-error' : 'is-success'"
      :aria-label="toast.kind === 'error' ? '操作失败' : '操作成功'"
    >
      <span>{{ toast.message }}</span>
      <el-button link size="small" @click="emit('dismissActionToast', toast.id)">关闭</el-button>
    </div>
    <div v-for="notice in props.cronNotices" :key="notice.id" class="undo-toast">
      <span>{{ notice.message }}</span>
      <el-button v-if="notice.auditId" link type="primary" size="small" @click="emit('undoCronAction', notice.auditId)">
        撤销
      </el-button>
      <el-button link size="small" @click="emit('dismissCronNotice', notice.id)">关闭</el-button>
    </div>
  </div>
</template>
