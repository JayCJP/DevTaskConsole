<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  cronPresets,
  describeCron,
  matchesPreset,
  nextCronRuns,
  validateCronExpression,
  type Cron,
} from '@devtask/shared'

const props = defineProps<{
  /** 弹层开关 */
  modelValue: boolean
  /** 待编辑的任务；缺省表示新建 */
  cron?: Cron | null
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
  /** 提交新的表达式与提示词 */
  save: [payload: { cron: string; prompt?: string }]
}>()

/** 当前表达式 */
const expression = ref('')
/** 当前提示词（仅新建时必填，编辑时留空表示不改） */
const prompt = ref('')

/**
 * 打开弹层时同步任务值。
 */
watch(
  () => [props.modelValue, props.cron?.id] as const,
  ([open]) => {
    if (!open) return
    expression.value = props.cron?.cron ?? cronPresets[0]?.expression ?? ''
    prompt.value = ''
  },
  { immediate: true },
)

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
  return props.serviceReady && effectivePrompt.value.length > 0
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
  })
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.cron ? `编辑定时任务 · ${props.cron.id}` : '新建定时任务'"
    width="min(520px, 94vw)"
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

      <label v-if="!props.cron" class="cron-field">
        <span>定时执行的提示词</span>
        <el-input v-model="prompt" type="textarea" :rows="4" placeholder="例如：检查我名下的新建与重开缺陷并按需修复" />
      </label>
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
