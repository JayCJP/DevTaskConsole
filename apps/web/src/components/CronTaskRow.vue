<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import { describeCron, type Cron } from '@devtask/shared'

/** 定时任务 owner 映射草稿，由父页面维护 */
interface CronMappingDraft {
  storyId: string
  ownerSessionId: string
  mode: '' | 'query_only' | 'query_fix'
  saving: boolean
  error: string
}

const props = defineProps<{
  /** 单条定时任务事实（快照 + 服务端实时字段的合并结果） */
  cron: Cron
  /** 该任务的 owner 映射草稿；未初始化时保存按钮不可用 */
  draft?: CronMappingDraft
  /** 该行是否有操作在进行中 */
  busy?: boolean
  /** 执行记录区是否已展开 */
  expanded?: boolean
  /** 当前未归档的派发轮次；存在时只能归档后才能再次派发 */
  openRound?: { roundId: string; createdAt: string; label?: string }
}>()

const emit = defineEmits<{
  /** 保存 owner 映射 */
  save: [taskId: string]
  /** 切换启用状态 */
  toggle: [enabled: boolean]
  /** 打开编辑弹层 */
  edit: []
  /** 展开/收起执行记录 */
  executions: []
  /** 续期 */
  renew: []
  /** 派发到独立轮次 */
  dispatch: []
  /** 归档当前未归档轮次 */
  archive: [outcome: 'succeeded' | 'failed' | 'stopped']
  /** 删除任务 */
  remove: []
}>()

/** 归属设置是否展开；默认收起，避免每个任务都展示完整表单 */
const mappingOpen = ref(false)

/** 任务模式的中文文案 */
const modeLabel = computed(() => {
  if (props.cron.mode === 'query_fix') return '查询 + 修复'
  if (props.cron.mode === 'query_only') return '只查询'
  return '模式待确认'
})

/** 状态的展示文案 */
const statusLabel = computed(() => {
  if (props.cron.enabled === true) return '运行中'
  if (props.cron.enabled === false) return '已暂停'
  return '状态未知'
})

/** 状态徽标的样式类 */
const statusClass = computed(() => {
  if (props.cron.enabled === true) return 'tag-success'
  if (props.cron.enabled === false) return 'tag-warning'
  return ''
})

/** 状态指示点样式 */
const statusDotClass = computed(() => {
  if (props.cron.enabled === true) return 'is-active'
  if (props.cron.enabled === false) return 'is-paused'
  return ''
})

/** 是否处于修复模式：需要在卡片内提示风险 */
const isFixMode = computed(() => props.cron.mode === 'query_fix')

/** 是否已校验人工 owner 映射：原生自动绑定不需要重复校验 */
const ownerUnverified = computed(() => Boolean(props.cron.ownerSessionId) && !props.cron.ownerVerifiedAt)

/** 当前可用于定时任务操作的 session，优先使用人工映射 */
const boundSessionId = computed(() => props.cron.ownerSessionId ?? props.cron.sessionId ?? '')

/** 执行归属的补充说明 */
const bindingLabel = computed(() => {
  const binding = props.cron.ownerSessionId ? '人工指定' : props.cron.sessionId ? '自动绑定实例' : '未绑定'
  return `${binding} · ${props.cron.durable ? '持久化任务' : '临时任务'}`
})

/** 是否需要用户补充或修正归属配置；任务模式不阻碍启停和调度编辑 */
const mappingNeedsAttention = computed(() => !props.cron.storyId || !boundSessionId.value || ownerUnverified.value)

/** 是否由用户显式确认过启用状态（状态未知时不能假设为运行中） */
const isEnabled = computed(() => props.cron.enabled === true)

/** 启停按钮文案：状态未知时按钮应表达「启用」，与实际请求一致 */
const toggleLabel = computed(() => (props.cron.enabled === true ? '暂停任务' : '启用任务'))

/** 是否存在需要在任务摘要下方展示的风险提示 */
const hasWarnings = computed(() => isFixMode.value || ownerUnverified.value || Boolean(props.openRound))

/** 归属设置按钮文案 */
const mappingButtonLabel = computed(() => mappingOpen.value ? '收起设置' : '归属设置')

/** 下次运行时间的可读文本 */
const nextRunText = computed(() => {
  if (!props.cron.nextRun) return '时间未知'
  return new Date(props.cron.nextRun).toLocaleString()
})

/** 到期日的可读文本 */
const expiresText = computed(() => (props.cron.expiresAt ? new Date(props.cron.expiresAt).toLocaleDateString() : ''))

/** cron 表达式的中文描述 */
const scheduleLabel = computed(() => describeCron(props.cron.cron))

watch(ownerUnverified, (unverified) => {
  if (unverified) mappingOpen.value = true
}, { immediate: true })

/**
 * 切换归属设置面板。
 */
function toggleMapping(): void {
  mappingOpen.value = !mappingOpen.value
}

/**
 * 处理低频操作菜单。
 * @param command 菜单动作标识
 */
function handleMoreCommand(command: string): void {
  if (command === 'renew') emit('renew')
  if (command === 'dispatch') emit('dispatch')
  if (command === 'archive-succeeded') confirmArchive('succeeded')
  if (command === 'archive-failed') confirmArchive('failed')
  if (command === 'archive-stopped') confirmArchive('stopped')
  if (command === 'remove') confirmRemove()
}

/**
 * 删除前二次确认：删除不可撤销。
 */
function confirmRemove(): void {
  if (window.confirm(`删除定时任务「${props.cron.id}」？该操作不可撤销。`)) emit('remove')
}

/**
 * 归档前二次确认：归档后该任务才能再次派发。
 * @param outcome 归档终态
 */
function confirmArchive(outcome: 'succeeded' | 'failed' | 'stopped'): void {
  const round = props.openRound
  if (!round) return
  const label = outcome === 'succeeded' ? '成功' : outcome === 'failed' ? '失败' : '已停止'
  if (window.confirm(`把轮次 ${round.roundId} 归档为「${label}」？归档后该任务才能再次派发。`)) {
    emit('archive', outcome)
  }
}
</script>

<template>
  <article class="cron-card" :class="{ 'is-busy': props.busy, 'is-expanded': props.expanded }">
    <div class="cron-card-heading">
      <div class="cron-primary">
        <div class="cron-title-line">
          <span class="status-dot" :class="statusDotClass" />
          <strong :title="props.cron.storyTitle || '未关联 Story'">{{ props.cron.storyTitle || '未关联 Story' }}</strong>
          <span class="tag" :class="statusClass">{{ statusLabel }}</span>
          <span class="cron-mode">{{ modeLabel }}</span>
        </div>
        <div class="cron-meta">
          <code>{{ props.cron.id }}</code>
          <span>{{ props.cron.storyId || 'Story 未映射' }}</span>
        </div>
        <p v-if="props.cron.promptFirstLine" class="cron-prompt-line" :title="props.cron.promptFirstLine">
          {{ props.cron.promptFirstLine }}
        </p>
      </div>
      <el-button
        class="cron-history-button"
        size="small"
        :type="props.expanded ? 'primary' : undefined"
        :plain="props.expanded"
        :aria-expanded="props.expanded"
        @click="emit('executions')"
      >
        {{ props.expanded ? '收起记录' : '执行记录' }}
      </el-button>
    </div>

    <div class="cron-facts">
      <div class="cron-fact">
        <span>调度规则</span>
        <strong>{{ scheduleLabel }}</strong>
        <code>{{ props.cron.cron }}</code>
      </div>
      <div class="cron-fact">
        <span>下次运行</span>
        <strong>{{ nextRunText }}</strong>
        <small v-if="expiresText">有效期至 {{ expiresText }}</small>
        <small v-else>未设置到期时间</small>
      </div>
      <div class="cron-fact cron-owner-fact">
        <span>执行归属</span>
        <strong :title="boundSessionId || '未关联实例'">{{ boundSessionId || '未关联实例' }}</strong>
        <small>{{ bindingLabel }}</small>
      </div>
    </div>

    <div v-if="hasWarnings" class="cron-warnings">
      <span v-if="isFixMode">修复模式可能修改代码或写回 TAPD。</span>
      <span v-if="ownerUnverified">owner 尚未通过归属校验，请重新保存映射。</span>
      <span v-if="props.openRound">
        轮次 {{ props.openRound.roundId }} 尚未归档，归档前无法再次派发。
      </span>
    </div>

    <footer class="cron-footer">
      <div class="cron-actions">
        <el-button
          size="small"
          :type="isEnabled ? undefined : 'primary'"
          :plain="!isEnabled"
          :loading="props.busy"
          :disabled="props.busy"
          @click="emit('toggle', !isEnabled)"
        >
          {{ toggleLabel }}
        </el-button>
        <el-button size="small" :disabled="props.busy" @click="emit('edit')">编辑调度</el-button>
        <el-button
          size="small"
          :disabled="!props.draft || props.busy"
          :aria-expanded="mappingOpen"
          @click="toggleMapping"
        >
          {{ mappingButtonLabel }}
          <span v-if="mappingNeedsAttention" class="cron-attention-dot" title="归属配置需要处理" />
        </el-button>
      </div>
      <el-dropdown trigger="click" :disabled="props.busy" @command="handleMoreCommand">
        <el-button size="small" :disabled="props.busy">
          更多<el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="renew" :disabled="!props.cron.durable">续期任务</el-dropdown-item>
            <el-dropdown-item command="dispatch" :disabled="!props.cron.storyId || Boolean(props.openRound)">
              {{ props.openRound ? '立即派发（需先归档）' : '立即派发' }}
            </el-dropdown-item>
            <el-dropdown-item v-if="props.openRound" command="archive-succeeded">
              归档轮次（成功）
            </el-dropdown-item>
            <el-dropdown-item v-if="props.openRound" command="archive-failed">
              归档轮次（失败）
            </el-dropdown-item>
            <el-dropdown-item v-if="props.openRound" command="archive-stopped">
              归档轮次（已停止）
            </el-dropdown-item>
            <el-dropdown-item command="remove" divided><span class="cron-danger-action">删除任务</span></el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </footer>

    <el-collapse-transition>
      <section v-show="mappingOpen && props.draft" class="cron-mapping">
        <div class="cron-mapping-heading">
          <div>
            <strong>执行归属</strong>
            <p>任务将由指定 Story 的专属 CodeBuddy session 执行。</p>
          </div>
          <code>{{ props.draft?.storyId || 'Story 未映射' }}</code>
        </div>
        <div v-if="props.draft" class="cron-mapping-fields">
          <label>
            <span>任务类型</span>
            <el-select v-model="props.draft.mode" placeholder="确认任务类型" :disabled="props.busy">
              <el-option label="只查询" value="query_only" />
              <el-option label="查询 + 修复" value="query_fix" />
            </el-select>
          </label>
          <label>
            <span>Owner session ID</span>
            <el-input v-model="props.draft.ownerSessionId" placeholder="输入专属 owner session ID" :disabled="props.busy" />
          </label>
          <el-button
            type="primary"
            size="small"
            :loading="props.draft.saving"
            :disabled="!props.draft.ownerSessionId.trim() || !props.draft.mode"
            @click="emit('save', props.cron.id)"
          >
            校验并保存
          </el-button>
        </div>
        <p v-if="props.draft?.error" class="mapping-error" role="alert">{{ props.draft.error }}</p>
      </section>
    </el-collapse-transition>

    <slot name="executions" />
  </article>
</template>

<style scoped>
.cron-card {
  position: relative;
  display: grid;
  gap: 16px;
  margin-top: 12px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-raised);
  transition: border-color .18s ease, background .18s ease, box-shadow .18s ease;
}
.cron-card:hover { border-color: color-mix(in srgb, var(--accent) 28%, var(--line)); }
.cron-card.is-expanded { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.cron-card.is-busy { background: color-mix(in srgb, var(--accent) 5%, var(--surface-raised)); }
.cron-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cron-primary { display: grid; min-width: 0; flex: 1; gap: 6px; }
.cron-title-line { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 8px; }
.cron-title-line > strong { overflow: hidden; max-width: min(100%, 520px); color: var(--text); font-size: 14px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.cron-title-line .status-dot { flex: 0 0 7px; }
.status-dot.is-paused { background: var(--amber); }
.cron-mode { color: var(--muted); font-size: 11px; }
.cron-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px 12px; color: var(--faint); font-size: 11px; }
.cron-meta code { overflow-wrap: anywhere; color: var(--muted); }
.cron-prompt-line { overflow: hidden; margin: 0; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.cron-history-button { flex: 0 0 auto; }
.cron-facts { display: grid; grid-template-columns: minmax(160px, .85fr) minmax(210px, 1fr) minmax(180px, 1fr); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.cron-fact { display: grid; min-width: 0; align-content: start; gap: 4px; padding: 12px 14px; }
.cron-fact + .cron-fact { border-left: 1px solid var(--line); }
.cron-fact > span { color: var(--faint); font-size: 10px; }
.cron-fact > strong { overflow: hidden; color: var(--text); font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.cron-fact > code, .cron-fact > small { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.cron-warnings { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: -6px; color: var(--amber); font-size: 11px; }
.cron-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cron-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cron-actions .el-button, .cron-footer > .el-dropdown .el-button { margin: 0; }
.cron-attention-dot { width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--amber); }
.cron-danger-action { color: var(--red); }
.cron-mapping { display: grid; width: auto; grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 14px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.cron-mapping-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cron-mapping-heading strong { color: var(--text); font-size: 12px; }
.cron-mapping-heading p { margin: 3px 0 0; color: var(--muted); font-size: 11px; }
.cron-mapping-heading code { color: var(--faint); font-size: 10px; }
.cron-mapping-fields { display: grid; grid-template-columns: minmax(160px, .6fr) minmax(240px, 1.4fr) auto; align-items: end; gap: 10px; }
.cron-mapping-fields label { display: grid; gap: 6px; color: var(--muted); font-size: 11px; }
.cron-mapping .mapping-error { margin: 0; }
.cron-card :deep(.cron-executions) { margin-top: 0; }

@media (max-width: 1050px) {
  .cron-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cron-owner-fact { grid-column: 1 / -1; border-top: 1px solid var(--line); border-left: 0 !important; }
  .cron-mapping-fields { grid-template-columns: minmax(150px, .7fr) minmax(210px, 1.3fr); }
  .cron-mapping-fields > .el-button { grid-column: 1 / -1; justify-self: start; }
}

@media (max-width: 640px) {
  .cron-card { gap: 14px; padding: 14px; }
  .cron-card-heading { gap: 10px; }
  .cron-title-line > strong { flex-basis: calc(100% - 18px); max-width: calc(100% - 18px); }
  .cron-history-button { padding-inline: 10px; }
  .cron-facts { grid-template-columns: minmax(0, 1fr); }
  .cron-fact + .cron-fact, .cron-owner-fact { grid-column: auto; border-top: 1px solid var(--line); border-left: 0; }
  .cron-fact > strong, .cron-fact > code, .cron-fact > small { white-space: normal; overflow-wrap: anywhere; }
  .cron-footer { align-items: flex-start; }
  .cron-actions { flex: 1; }
  .cron-mapping { padding: 13px; }
  .cron-mapping-heading { flex-direction: column; }
  .cron-mapping-fields { grid-template-columns: minmax(0, 1fr); }
  .cron-mapping-fields > .el-button { grid-column: auto; width: 100%; }
}
</style>
