import type { Cron } from '@devtask/shared'
import type { CronTaskMapping } from './cron-data.js'
import type { RemoteScheduledTask } from '../services/scheduled-tasks.js'

/**
 * 单个 Story 服务返回的实时任务集合。
 * 服务进程的 cwd 就是该 Story 工作区，因此这里的任务默认归属该 Story；
 * 若本地文件或 owner 映射已经给出归属，以本地事实为准。
 */
export interface CronRealtimeSource {
  /** 实时数据来源 Story */
  storyId: string
  /** 该 Story 工作区相对路径，用于补齐本地缺失的归位信息 */
  workspacePath?: string
  /** CodeBuddy 返回的实时任务 */
  tasks: RemoteScheduledTask[]
}

/**
 * 用实时任务覆盖本地文件事实，得到最终对外展示的定时任务列表。
 *
 * 合并规则（逐字段）：
 * - 归属信息（storyId/workspacePath/storyTitle/mode/ownerSessionId/ownerVerifiedAt）以本地文件与映射为准；
 * - 运行期事实（cron/enabled/nextRun/lastFiredAt/expiresAt）以实时数据为准，实时数据缺省时回落到本地；
 * - 本地存在但实时没返回的任务原样保留（服务未运行或任务归属其它 Story）。
 *
 * @param local 本地文件扫出的任务（保持顺序）
 * @param sources 各运行中 Story 服务返回的实时任务
 * @param mappings 本地 owner 映射，用于补齐本地文件缺失的归属与模式
 * @returns 合并后的任务列表；新任务追加在本地任务之后
 */
export function mergeCronFacts(
  local: Cron[],
  sources: CronRealtimeSource[],
  mappings: CronTaskMapping[],
): Cron[] {
  if (sources.length === 0) return local
  const localById = new Map(local.map((cron) => [cron.id, cron]))
  const mappingByTask = new Map(mappings.map((mapping) => [mapping.taskId, mapping]))
  const merged = new Map<string, Cron>(local.map((cron) => [cron.id, cron]))
  const appended: Cron[] = []

  for (const source of sources) {
    for (const remote of source.tasks) {
      const base = localById.get(remote.id)
      const mapping = mappingByTask.get(remote.id)
      const storyId = base?.storyId ?? mapping?.storyId ?? source.storyId
      const workspacePath = base?.workspacePath ?? source.workspacePath
      const mode = base?.mode ?? mapping?.mode
      const ownerSessionId = base?.ownerSessionId ?? mapping?.ownerSessionId
      const ownerVerifiedAt = base?.ownerVerifiedAt ?? mapping?.ownerVerifiedAt
      const sessionId = remote.sessionId ?? base?.sessionId
      const promptFirstLine = base?.promptFirstLine ?? firstLine(remote.prompt)
      const mergedTask: Cron = {
        id: remote.id,
        ...(storyId ? { storyId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        ...(base?.storyTitle ? { storyTitle: base.storyTitle } : {}),
        cron: remote.cron,
        ...(remote.enabled !== undefined
          ? { enabled: remote.enabled }
          : base?.enabled !== undefined
            ? { enabled: base.enabled }
            : {}),
        ...(mode ? { mode } : {}),
        ...(ownerSessionId ? { ownerSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(ownerVerifiedAt ? { ownerVerifiedAt } : {}),
        ...(promptFirstLine ? { promptFirstLine } : {}),
        ...(remote.durable !== undefined
          ? { durable: remote.durable }
          : base?.durable !== undefined
            ? { durable: base.durable }
            : {}),
        ...(remote.recurring !== undefined
          ? { recurring: remote.recurring }
          : base?.recurring !== undefined
            ? { recurring: base.recurring }
            : {}),
        ...(remote.expiryDays !== undefined
          ? { expiryDays: remote.expiryDays }
          : base?.expiryDays !== undefined
            ? { expiryDays: base.expiryDays }
            : {}),
        ...(remote.nextRun ? { nextRun: remote.nextRun } : {}),
        ...(remote.lastFiredAt
          ? { lastFiredAt: remote.lastFiredAt }
          : base?.lastFiredAt
            ? { lastFiredAt: base.lastFiredAt }
            : {}),
        ...(remote.expiresAt ? { expiresAt: remote.expiresAt } : {}),
        ...(base?.lastExecution ? { lastExecution: base.lastExecution } : {}),
      }
      if (base) merged.set(remote.id, mergedTask)
      else appended.push(mergedTask)
    }
  }

  return [...merged.values(), ...appended]
}

/**
 * 取提示词首行作为列表摘要，避免把整段 prompt 带进快照。
 * @param prompt 上游返回的提示词
 * @returns 首行摘要；缺失时返回 undefined
 */
function firstLine(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined
  const line = prompt.split(/\r?\n/, 1)[0]?.slice(0, 200)
  return line && line.trim() ? line : undefined
}
