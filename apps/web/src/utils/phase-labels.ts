/**
 * Harness 七阶段（P0–P6）的中文名称。
 * 名称来源：harness-marketplace 的 Phase Agent 定义（需求分析师 / 任务规划师 /
 * 前端开发工程师 / 代码审查师 / 发布助手 Phase 4-6），与 e2e-state.json 的 phase 取值一一对应。
 * 站点只做只读展示，不在这里判定或推进阶段。
 */

/** Harness 启动模式 */
export type HarnessMode = 'run' | 'fixbugs' | undefined

/** 阶段序号 → 中文名称（run 模式 / 未指定模式） */
export const PHASE_LABELS: Readonly<Record<number, string>> = {
  0: '需求分析',
  1: '任务规划',
  2: '代码开发',
  3: '代码审查',
  4: '提交合并',
  5: '知识库更新',
  6: '构建部署',
}

/**
 * 取阶段的中文名称。
 * Phase 0 随模式分流：fixbugs 模式做的是 Bug 分析，run 模式才是需求分析。
 * 其余阶段两种模式同名（harness 需求分析师在 fixbugs 下先写 Bug 分析报告，
 * 再写需求分析，但对外仍归在 Phase 0）。
 * @param phase Harness 阶段序号（0–6）
 * @param mode Harness 启动模式；仅影响 Phase 0 的文案
 * @returns 中文阶段名；无有效阶段时返回 undefined
 */
export function phaseLabel(phase: number | undefined, mode?: HarnessMode): string | undefined {
  if (phase === undefined) return undefined
  if (phase === 0 && mode === 'fixbugs') return 'bug分析'
  return PHASE_LABELS[phase]
}

/**
 * 把阶段格式化为「P3 代码审查」这样的紧凑标签。
 * @param phase Harness 阶段序号（0–6）
 * @param mode Harness 启动模式；仅影响 Phase 0 的文案
 * @returns 带序号的中文阶段标签；无有效阶段时返回 undefined
 */
export function phaseTag(phase: number | undefined, mode?: HarnessMode): string | undefined {
  const label = phaseLabel(phase, mode)
  return label === undefined ? undefined : `P${phase} ${label}`
}
