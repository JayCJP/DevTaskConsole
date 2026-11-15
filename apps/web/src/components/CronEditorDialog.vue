<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  cronPresets,
  describeCron,
  matchesPreset,
  nextCronRuns,
  validateCronExpression,
  type Cron,
  type CronMode,
  type Requirement,
} from '@devtask/shared'
import { buildCronPrompt, type CronPromptContext } from '../utils/cron-prompt'

const props = defineProps<{
  /** 弹层开关 */
  modelValue: boolean
  /** 待编辑的任务；缺省表示新建 */
  cron?: Cron | null
  /** 新建任务对应的 Story 及 TAPD 信息 */
  requirement?: Requirement | null
  /** 当前 Story 工作区中的 plans 绝对路径 */
  plansDir?: string
  /** 该 Story 是否有可用服务端口 */
  serviceReady: boolean
  /** 保存中标记 */
  saving: boolean
  /** 保存失败信息 */
  error: string
}>()

const emit = defineEmits<{
  /** 更新弹层开关 */
  'update:modelValue': [value: boolean]
  /** 提交新的表达式、提示词与任务模式 */
  save: [payload: { cron: string; prompt?: string; mode?: CronMode }]
}>()

/** 当前表达式 */
const expression = ref('')
/** 当前提示词（仅新建时必填，编辑时留空表示不改） */
const prompt = ref('')
/** 新建任务模式；按照 skill 安全约束默认只查 */
const mode = ref<CronMode>('query_only')

/** 当前 Story 对应的模板替换上下文 */
const promptContext = computed<CronPromptContext>(() => ({
  storyTitle: props.requirement?.title ?? '',
  tapdStoryId: props.requirement?.tapdStoryId ?? '',
  workspaceId: props.requirement?.tapdWorkspaceId ? String(props.requirement.tapdWorkspaceId) : '',
  owner: props.requirement?.owner ?? '',
  storyId: props.requirement?.storyId ?? '',
  plansDir: props.plansDir ?? '',
}))

/** 创建前必须补齐的 TAPD 或工作区信息 */
const missingTemplateFields = computed(() => {
  const missing: string[] = []
  if (!promptContext.value.storyTitle) missing.push('需求标题')
  if (!promptContext.value.tapdStoryId) missing.push('TAPD 需求 ID')
  if (!promptContext.value.workspaceId) missing.push('TAPD workspace_id')
  if (!promptContext.value.owner) missing.push('处理人')
  if (mode.value === 'query_fix') {
    if (!promptContext.value.storyId) missing.push('Harness Story ID')
    if (!promptContext.value.plansDir) missing.push('plans 目录')
  }
  return missing
})

/** 模板是否已具备创建条件，禁止把未替换的占位符写入任务 */
const templateReady = computed(() => (
  missingTemplateFields.value.length === 0 && !prompt.value.includes('{{')
))

/** 模板缺失信息的可读文本 */
const missingTemplateText = computed(() => missingTemplateFields.value.join('、'))

/** 当前模式的说明与副作用提示 */
const modeHint = computed(() => (
  mode.value === 'query_fix'
    ? '自动修复会调用 /start fixbugs，可能修改代码、写 TAPD 评论并变更缺陷状态。'
    : '只查询并输出缺陷清单，不改代码、不写评论、不变更缺陷状态。'
))

/**
 * 按当前模式生成完整默认提示词。
 * @returns 替换 Story 信息后的模板
 */
function defaultPrompt(): string {
  return buildCronPrompt(mode.value, promptContext.value)
}

/**
 * 打开弹层时同步任务值；新建时生成当前 Story 的默认模板。
 */
watch(
  () => [props.modelValue, props.cron?.id] as const,
  ([open]) => {
    if (!open) return
    expression.value = props.cron?.cron ?? cronPresets[0]?.expression ?? ''
    mode.value = 'query_only'
    prompt.value = props.cron ? '' : defaultPrompt()
  },
  { immediate: true },
)

/** 切换模式时整段重新生成，避免把只查与修复步骤混在同一提示词里 */
watch(mode, () => {
  if (props.modelValue && !props.cron) prompt.value = defaultPrompt()
})

/** 校验结果 */
const validation = computed(() => validateCronExpression(expression.value))

/** 校验是否通过 */
const valid = computed(() => validation.value.ok)

/** 校验失败原因 */
const invalidReason = computed(() => (validation.value.ok ? '' : validation.value.message))

/** 生效的提示词：新建任务必须有提示词 */
const effectivePrompt = computed(() => prompt.value.trim())

/** 是否可以提交 */
const canSubmit = computed(() => {
  if (!valid.value || props.saving) return false
  if (props.cron) return true
  return props.serviceReady && effectivePrompt.value.length > 0 && templateReady.value
})

/** 未来三次运行时间 */
const upcoming = computed(() => {
  if (!valid.value) return []
  return nextCronRuns(expression.value, new Date(), 3)
})

/** 表达式的中文描述 */
const scheduleLabel = computed(() => describeCron(expression.value))

/**
 * 选中预设。
 * @param presetExpression 预设表达式
 */
function selectPreset(presetExpression: string): void {
  expression.value = presetExpression
}

/**
 * 判断预设是否为当前选中项。
 * @param presetExpression 预设表达式
 * @returns 选中返回 true
 */
function isPresetActive(presetExpression: string): boolean {
  return matchesPreset(expression.value, { id: '', label: '', minutes: 0, expression: presetExpression })
}

/**
 * 提交表单。
 */
function submit(): void {
  if (!canSubmit.value) return
  emit('save', {
    cron: expression.value.trim(),
    ...(effectivePrompt.value ? { prompt: effectivePrompt.value } : {}),
    ...(props.cron ? {} : { mode: mode.value }),
  })
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.cron ? `编辑定时任务 · ${props.cron.id}` : '新建定时任务'"
    width="min(720px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="cron-editor">
      <p class="cron-editor-hint">预设均已避开 0 分与 30 分，避免与其他整点调度撞车。</p>
      <div class="cron-presets">
        <el-button
          v-for="preset in cronPresets"
          :key="preset.id"
          size="small"
          :type="isPresetActive(preset.expression) ? 'primary' : undefined"
          @click="selectPreset(preset.expression)"
        >
          {{ preset.label }}
        </el-button>
      </div>

      <label class="cron-field">
        <span>cron 表达式（分 时 日 月 周）</span>
        <el-input v-model="expression" placeholder="15,45 * * * *" />
      </label>
      <p v-if="!valid" class="mapping-error" role="alert">{{ invalidReason }}</p>
      <p v-else class="cron-editor-ok">{{ scheduleLabel }}</p>

      <template v-if="!props.cron">
        <div class="cron-mode-field">
          <span>任务模式</span>
          <el-radio-group v-model="mode">
            <el-radio-button value="query_only">只查询</el-radio-button>
            <el-radio-button value="query_fix">查询 + 自动修复</el-radio-button>
          </el-radio-group>
          <small :class="{ 'cron-mode-warning': mode === 'query_fix' }">{{ modeHint }}</small>
        </div>
        <div class="cron-template-source">
          已根据 Story「{{ props.requirement?.title || '未命名需求' }}」生成完整模板；创建后持久化保存，有效期 30 天。
        </div>
        <p v-if="missingTemplateFields.length" class="mapping-error" role="alert">
          缺少模板信息：{{ missingTemplateText }}。请先补齐该 Story 的 TAPD 与工作区信息。
        </p>
        <label class="cron-field">
          <span>定时执行的提示词</span>
          <el-input v-model="prompt" type="textarea" :rows="14" placeholder="选择 Story 后自动生成 TAPD 缺陷巡检模板" />
        </label>
      </template>
      <p v-else class="cron-editor-hint">提示词不在本弹层修改，避免误改正在运行的任务上下文。</p>

      <div v-if="upcoming.length" class="cron-upcoming">
        <span>未来三次运行</span>
        <ul>
          <li v-for="run in upcoming" :key="run.toISOString()">{{ run.toLocaleString() }}</li>
        </ul>
      </div>
      <p v-if="!props.serviceReady" class="mapping-error" role="alert">
        该 Story 的 CodeBuddy 服务未运行，无法创建任务。请先在实例页启动服务。
      </p>
      <p v-if="props.error" class="mapping-error" role="alert">{{ props.error }}</p>
    </div>
    <template #footer>
      <el-button :disabled="props.saving" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="props.saving" :disabled="!canSubmit" @click="submit">
        {{ props.cron ? '保存' : '创建' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cron-mode-field { display: grid; gap: 8px; color: var(--muted); font-size: 11px; }
.cron-mode-field small { line-height: 1.6; }
.cron-mode-warning { color: var(--amber); }
.cron-template-source { padding: 10px 12px; border: 1px solid var(--line-subtle); border-radius: var(--radius-sm); background: var(--bg-inset); color: var(--muted); font-size: 11px; line-height: 1.6; }
</style>
