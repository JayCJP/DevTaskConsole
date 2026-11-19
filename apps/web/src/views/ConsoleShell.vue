<script setup lang="ts">
/**
 * 控制台壳层视图。
 * 作为所有页面路由的父级，只创建一次：持有跨页共享状态（需求详情抽屉、审计抽屉、提示条），
 * 通过 provide 下发给各子页面，因此切换路由不会丢失抽屉状态或停止全局轮询。
 */
import { useConsole } from '../composables/useConsole'
import { provideConsoleContext } from '../composables/useConsoleContext'
import AuditTrailDrawer from '../components/AuditTrailDrawer.vue'
import RequirementDetailDrawer from '../components/RequirementDetailDrawer.vue'
import ActionToasts from '../components/ActionToasts.vue'

/** 创建唯一的控制台上下文并在整棵页面树中共享 */
const ctx = useConsole()
provideConsoleContext(ctx)

const {
  page,
  pageHeading,
  store,
  refreshCurrentPage,
  selectedRequirement,
  detailOpen,
  selectedBugs,
  selectedHarnessBugs,
  selectedQuestions,
  tapdAvailable,
  auditOpen,
  auditEntries,
  auditLoading,
  auditError,
  auditUndoingId,
  refreshAuditTrail,
  undoAuditEntry,
  actionToastItems,
  cronNotices,
  dismissActionToast,
  undoCronAction,
  dismissCronNotice,
} = ctx
</script>

<template>
  <section class="page-content">
    <div class="page-heading-row">
      <div>
        <h1>{{ pageHeading }}</h1>
        <!-- 只在收件箱与发布页保留副标题：其余页面的说明由各分区标题自带，H1 不再叠加同义句 -->
        <p v-if="page === 'inbox'" class="page-subtitle">先处理真正需要你决策的事项。</p>
        <p v-else-if="page === 'releases'" class="page-subtitle">
          按工作区构建项目 · 状态来自 DevOps 与本机快照，不伪装成实时
        </p>
      </div>
      <div class="heading-actions">
        <span v-if="store.snapshot" class="freshness"
          >快照 {{ new Date(store.snapshot.snapshotAt).toLocaleTimeString() }}</span
        >
      </div>
    </div>

    <div v-if="store.error" class="notice notice-warning" role="status">
      <span class="notice-symbol">!</span>
      <div>
        <strong>数据暂不可用</strong>
        <p>{{ store.error }}</p>
        <p>此页只聚合展示上游系统状态，不会替代它们执行操作；修复上方原因后可重试。</p>
      </div>
      <el-button text @click="refreshCurrentPage()">重试</el-button>
    </div>

    <!-- 各页面内容由独立视图渲染 -->
    <RouterView />
  </section>

  <!-- 跨页共享：需求详情抽屉（切页不丢失） -->
  <RequirementDetailDrawer
    v-model="detailOpen"
    :requirement="selectedRequirement"
    :bugs="selectedBugs"
    :harness-bugs="selectedHarnessBugs"
    :questions="selectedQuestions"
    :tapd-available="tapdAvailable"
  />

  <!-- 操作审计抽屉：白名单动作可撤销 -->
  <AuditTrailDrawer
    v-model="auditOpen"
    :entries="auditEntries"
    :loading="auditLoading"
    :error="auditError"
    :undoing-id="auditUndoingId"
    @refresh="refreshAuditTrail()"
    @undo="undoAuditEntry($event)"
  />

  <!-- 撤销提示条：不打断流程，超时自动消失 -->
  <ActionToasts
    :action-toast-items="actionToastItems"
    :cron-notices="cronNotices"
    @dismiss-action-toast="dismissActionToast($event)"
    @undo-cron-action="undoCronAction($event)"
    @dismiss-cron-notice="dismissCronNotice($event)"
  />
</template>
