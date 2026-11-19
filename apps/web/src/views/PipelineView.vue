<script setup lang="ts">
/**
 * pipeline 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'
import PipelineFlow from '../components/PipelineFlow.vue'
const {
  workspacePipelines,
  pipelineStoryCount,
  activeWorkflows,
  openRequirement,
  goCrons,
  snapshotLoaded,
} = useConsoleContext()
</script>

<template>
      <section class="surface">
        <div class="section-heading"><div><h2>端到端链路</h2><p>一个工作区一条流水线：Story 只从第一个项目的 .codebuddy/plans 识别</p></div><span class="count-pill">{{ workspacePipelines.length }} 个工作区 · {{ pipelineStoryCount }} 个 Story</span></div>
        <div v-for="workflow in activeWorkflows" :key="`${workflow.workspacePath}:${workflow.storyId}`" class="notice notice-warning">
          <span class="notice-symbol">!</span>
          <div><strong>Harness 活跃流程：{{ workflow.title }}</strong><p>{{ workflow.storyId }} · {{ workflow.mode || '模式未知' }} · Phase {{ workflow.phase ?? '未知' }} · {{ workflow.status || '状态未知' }} · {{ workflow.workspacePath }}</p></div>
        </div>

        <PipelineFlow
          :pipelines="workspacePipelines"
          @open-story="openRequirement"
          @go-crons="goCrons"
        />

        <div v-if="!workspacePipelines.length && !snapshotLoaded" class="empty-compact">正在加载快照…</div>
        <div v-else-if="!workspacePipelines.length" class="empty-state"><strong>还没有工作区</strong><p>先在「工作区」页新建工作区；Story 需要放在第一个项目的 .codebuddy/plans 下。</p></div>
      </section>
</template>
