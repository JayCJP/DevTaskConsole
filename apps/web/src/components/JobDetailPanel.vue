<script setup lang="ts">
import { computed } from 'vue'
import type { JobDetail } from '@devtask/shared'
import { formatTime } from '../utils/format-time'

const props = defineProps<{
  /** 实例详情；未加载时缺省 */
  detail?: JobDetail | null
  /** 详情加载中 */
  loading: boolean
  /** 详情读取失败原因 */
  error: string
  /** 当前实例是否已置顶 */
  pinned: boolean
  /** 置顶写操作进行中 */
  pinSaving: boolean
}>()

const emit = defineEmits<{
  /** 切换置顶 */
  'toggle-pin': []
  /** 把建议回复填入回复框 */
  'use-suggestion': [text: string]
}>()

/** 是否有可展示的详情内容 */
const hasContent = computed(() =>
  Boolean(
    props.detail?.detail ||
    props.detail?.needs ||
    props.detail?.suggestedReply ||
    props.detail?.startedAt,
  ),
)

/** 起止时间摘要 */
const timeSummary = computed(() => {
  if (!props.detail) return ''
  return `开始 ${formatTime(props.detail.startedAt)} · 更新 ${formatTime(props.detail.updatedAt)}`
})
</script>

<template>
  <section class="job-detail" aria-label="实例详情">
    <div class="job-detail-head">
      <h3>实例详情</h3>
      <div class="job-detail-actions">
        <el-button size="small" :loading="props.pinSaving" @click="emit('toggle-pin')">
          {{ props.pinned ? '取消置顶' : '置顶该实例' }}
        </el-button>
        <a v-if="props.detail?.webUrl" :href="props.detail.webUrl" target="_blank" rel="noreferrer"
          >打开原页面</a
        >
      </div>
    </div>

    <p v-if="props.loading" class="muted">正在读取实例详情…</p>
    <p v-else-if="props.error" class="mapping-error" role="alert">{{ props.error }}</p>
    <p v-else-if="!hasContent" class="muted">上游没有提供更多详情。</p>
    <template v-else>
      <div v-if="props.detail?.detail" class="job-detail-block">
        <span>当前活动</span>
        <p>{{ props.detail.detail }}</p>
      </div>
      <div v-if="props.detail?.needs" class="job-detail-block is-waiting">
        <span>等待输入</span>
        <p>{{ props.detail.needs }}</p>
      </div>
      <div v-if="props.detail?.suggestedReply" class="job-detail-block">
        <span>建议回复</span>
        <p>{{ props.detail.suggestedReply }}</p>
        <el-button size="small" @click="emit('use-suggestion', props.detail?.suggestedReply ?? '')">
          填入回复框
        </el-button>
      </div>
      <small class="job-detail-time"
        >{{ timeSummary }}<span v-if="props.detail?.settled"> · 已终结</span></small
      >
    </template>
  </section>
</template>
