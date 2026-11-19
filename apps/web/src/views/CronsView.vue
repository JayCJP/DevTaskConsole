<script setup lang="ts">
/**
 * crons 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'
import CronTaskRow from '../components/CronTaskRow.vue'
import CronExecutionList from '../components/CronExecutionList.vue'
import CronEditorDialog from '../components/CronEditorDialog.vue'
const {
  crons,
  activeCronCount,
  pausedCronCount,
  attentionCronCount,
  filteredCronCount,
  cronError,
  openAuditTrail,
  cronQuery,
  cronStatusFilter,
  cronHasActiveFilters,
  resetCronFilters,
  visibleCronGroups,
  cronBusyTaskId,
  expandedCronId,
  openDispatchOf,
  toggleCron,
  openCronEditor,
  toggleCronExecutions,
  renewCron,
  dispatchCron,
  archiveCronRound,
  removeCron,
  cronExecutionRows,
  cronExecutionsLoading,
  cronExecutionsError,
  cronExecutionsSource,
  cronExecutionsWarning,
  cronExecutionsHasMore,
  loadCronExecutions,
  loadMoreCronExecutions,
  copyText,
  openCronCreator,
  cronGroupsEmpty,
  cronEditorOpen,
  editingCron,
  editorRequirement,
  editorPlansDir,
  editorServiceReady,
  cronSaving,
  cronEditorError,
  submitCronEditor,
} = useConsoleContext()
</script>

<template>
      <section class="surface cron-surface">
        <div class="section-heading">
          <div><h2>任务调度</h2><p>按工作区查看任务；实例自动绑定，执行记录在卡片内查看。</p></div>
          <el-button @click="openAuditTrail">操作审计</el-button>
        </div>
        <div class="cron-overview" aria-label="定时任务概览">
          <div><span>全部任务</span><strong>{{ crons.length }}</strong></div>
          <div><span class="status-dot is-active" /><span>运行中</span><strong>{{ activeCronCount }}</strong></div>
          <div><span class="status-dot cron-paused-dot" /><span>已暂停</span><strong>{{ pausedCronCount }}</strong></div>
          <div :class="{ 'has-attention': attentionCronCount > 0 }"><span>待完善配置</span><strong>{{ attentionCronCount }}</strong></div>
        </div>
        <div class="cron-toolbar">
          <el-input v-model="cronQuery" class="cron-search" placeholder="搜索任务、Story 或 cron 表达式" clearable />
          <el-select v-model="cronStatusFilter" class="cron-status-filter" aria-label="筛选任务状态">
            <el-option label="全部状态" value="all" />
            <el-option label="运行中" value="enabled" />
            <el-option label="已暂停" value="paused" />
            <el-option label="待完善配置" value="attention" />
          </el-select>
          <span v-if="cronHasActiveFilters" class="cron-filter-result">{{ filteredCronCount }} / {{ crons.length }} 个任务</span>
          <el-button v-if="cronHasActiveFilters" link type="primary" @click="resetCronFilters">清除筛选</el-button>
        </div>
        <p v-if="cronError" class="mapping-error" role="alert">{{ cronError }}</p>
        <div v-for="group in visibleCronGroups" :key="group.key" class="workspace-block cron-workspace-block">
          <div class="workspace-block-head">
            <div class="workspace-main"><strong>{{ group.name }}</strong><small><code>{{ group.path }}</code></small></div>
          </div>
          <article class="project-block">
            <div class="project-head">
              <strong>{{ group.project?.name ?? '未声明项目' }}</strong>
              <code v-if="group.project?.branch">{{ group.project?.branch }}</code>
              <small class="muted">{{ group.stories.length }} 个 Story · {{ group.looseCrons.length }} 个未关联任务</small>
            </div>
            <div v-if="!group.stories.length && !group.looseCrons.length" class="project-empty">第一个项目暂无定时任务。</div>
            <CronTaskRow
              v-for="cron in group.looseCrons"
              :key="`loose:${cron.id}`"
              :cron="cron"
                            :busy="cronBusyTaskId === cron.id"
              :expanded="expandedCronId === cron.id"
              :open-round="openDispatchOf(cron.id)"
                            @toggle="toggleCron(cron, $event)"
              @edit="openCronEditor(cron)"
              @executions="toggleCronExecutions(cron)"
              @renew="renewCron(cron)"
              @dispatch="dispatchCron(cron)"
              @archive="archiveCronRound(cron, $event)"
              @remove="removeCron(cron)"
            >
              <template #executions>
                <CronExecutionList
                  v-if="expandedCronId === cron.id"
                  :executions="cronExecutionRows"
                  :loading="cronExecutionsLoading"
                  :error="cronExecutionsError"
                  :source="cronExecutionsSource"
                  :warning="cronExecutionsWarning"
                  :has-more="cronExecutionsHasMore"
                  @filter="loadCronExecutions(cron.id, $event)"
                  @more="loadMoreCronExecutions()"
                  @copy="copyText"
                />
              </template>
            </CronTaskRow>
            <template v-for="story in group.stories" :key="story.requirement.storyId">
              <div class="cron-story-head">
                <strong>{{ story.requirement.title }}</strong>
                <code>{{ story.requirement.storyId }}</code>
                <el-button size="small" type="primary" plain @click="openCronCreator(story.requirement.storyId)">
                  新建任务
                </el-button>
              </div>
              <p v-if="!story.crons.length" class="cron-story-empty">暂无定时任务，点击「新建任务」创建第一条调度。</p>
              <CronTaskRow
                v-for="cron in story.crons"
                :key="cron.id"
                :cron="cron"
                                :busy="cronBusyTaskId === cron.id"
                :expanded="expandedCronId === cron.id"
                :open-round="openDispatchOf(cron.id)"
                                @toggle="toggleCron(cron, $event)"
                @edit="openCronEditor(cron)"
                @executions="toggleCronExecutions(cron)"
                @renew="renewCron(cron)"
                @dispatch="dispatchCron(cron)"
                @archive="archiveCronRound(cron, $event)"
                @remove="removeCron(cron)"
              >
                <template #executions>
                  <CronExecutionList
                    v-if="expandedCronId === cron.id"
                    :executions="cronExecutionRows"
                    :loading="cronExecutionsLoading"
                    :error="cronExecutionsError"
                    :source="cronExecutionsSource"
                    :warning="cronExecutionsWarning"
                    :has-more="cronExecutionsHasMore"
                    @filter="loadCronExecutions(cron.id, $event)"
                    @more="loadMoreCronExecutions()"
                    @copy="copyText"
                  />
                </template>
              </CronTaskRow>
            </template>
          </article>
          <template v-if="group.unassignedCrons.length">
            <div class="cron-story-head"><strong>未归属任务</strong></div>
            <CronTaskRow
              v-for="cron in group.unassignedCrons"
              :key="cron.id"
              :cron="cron"
                            :busy="cronBusyTaskId === cron.id"
              :expanded="expandedCronId === cron.id"
              :open-round="openDispatchOf(cron.id)"
                            @toggle="toggleCron(cron, $event)"
              @edit="openCronEditor(cron)"
              @executions="toggleCronExecutions(cron)"
              @renew="renewCron(cron)"
              @dispatch="dispatchCron(cron)"
              @archive="archiveCronRound(cron, $event)"
              @remove="removeCron(cron)"
            >
              <template #executions>
                <CronExecutionList
                  v-if="expandedCronId === cron.id"
                  :executions="cronExecutionRows"
                  :loading="cronExecutionsLoading"
                  :error="cronExecutionsError"
                  :source="cronExecutionsSource"
                  :warning="cronExecutionsWarning"
                  :has-more="cronExecutionsHasMore"
                  @filter="loadCronExecutions(cron.id, $event)"
                  @more="loadMoreCronExecutions()"
                  @copy="copyText"
                />
              </template>
            </CronTaskRow>
          </template>
        </div>
        <div v-if="cronGroupsEmpty && !visibleCronGroups.length" class="empty-state"><strong>暂无定时任务</strong><p>检查需求工作区中的 .codebuddy/scheduled_tasks.json，或在 Story 行点击「新建任务」通过 API 创建。</p></div>
        <div v-else-if="!filteredCronCount" class="empty-state"><strong>没有符合条件的任务</strong><p>试试其他关键词或状态。</p><el-button size="small" @click="resetCronFilters">清除筛选</el-button></div>
      </section>

  <!-- 定时任务编辑弹层：预设、实时校验与下次运行预览 -->
  <CronEditorDialog
    v-model="cronEditorOpen"
    :cron="editingCron"
    :requirement="editorRequirement"
    :plans-dir="editorPlansDir"
    :service-ready="editorServiceReady"
    :saving="cronSaving"
    :error="cronEditorError"
    @save="submitCronEditor"
  />

</template>
