<script setup lang="ts">
/**
 * releases 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  releaseGatePhase,
  buildBlockReason,
  branchOfEnv,
  selectedBuildEnv,
  buildOtherOf,
  envSpecOf,
  workspaces,
  releaseMrError,
  devopsAppOf,
  devopsGroupOf,
  buildConfirmItems,
  buildOutcomes,
  releaseMrStatusLabel,
  buildEnvironments,
  selectBuildEnv,
  workspacesLoading,
  buildAllowed,
  buildingApps,
  requestWorkspaceBuild,
  releaseMrCreating,
  createReleaseMr,
  isAppBuilding,
  requestSingleBuild,
  mrKey,
  buildConfirmOpen,
  canSubmitBuild,
  submitBuilds,
  releaseMrDialogOpen,
  releaseMrDialogItems,
  releaseMrStatusClass,
} = useConsoleContext()
</script>

<template>
      <!-- 护栏横幅：门控 / 通道不可用，状态同时用色与文字表达 -->
      <div v-if="buildBlockReason" class="release-guard" :class="releaseGatePhase !== undefined ? 'is-danger' : 'is-warning'" role="alert">
        <svg class="release-guard-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 1.7 16.4a1 1 0 0 0 .87 1.5h15a1 1 0 0 0 .87-1.5L10 2.5Zm0 4.2a1 1 0 0 1 1 1v4.1a1 1 0 1 1-2 0V7.7a1 1 0 0 1 1-1Zm0 8.3a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3Z" fill="currentColor"/></svg>
        <div>
          <strong>{{ releaseGatePhase !== undefined ? 'Harness 发布窗口已锁定' : 'DevOps 通道不可用' }}</strong>
          <p>{{ buildBlockReason }}</p>
        </div>
      </div>

      <!-- 发射控制条：环境分段器 + 固定分支/build_other 展示 + 操作按钮 -->
      <section class="surface release-control">
        <div class="release-control-row">
          <div class="release-env-picker">
            <span class="release-label">构建 / MR 环境</span>
            <div class="env-segments" role="group" aria-label="构建环境">
              <button
                v-for="env in buildEnvironments"
                :key="env"
                type="button"
                class="env-segment"
                :class="{ 'is-active': selectedBuildEnv === env, 'is-prod': env === 'prod' }"
                :aria-pressed="selectedBuildEnv === env"
                @click="selectBuildEnv(env)"
              >
                <span>{{ env }}</span>
              </button>
            </div>
            <div class="release-env-facts">
              <span>构建分支 <code>{{ branchOfEnv(selectedBuildEnv) }}</code></span>
              <span>build_other <code>{{ buildOtherOf(selectedBuildEnv) }}</code></span>
              <span>MR 目标 <code>{{ envSpecOf(selectedBuildEnv).mrTargetBranch }}</code></span>
            </div>
          </div>
        </div>
      </section>

      <!-- 工作区分组的项目清单 -->
      <section class="surface">
        <div class="section-heading">
          <div><h2>工作区项目</h2><p>构建分支与 build_other 由顶部所选环境统一决定；MR 源分支取项目当前检出分支。</p></div>
          <span class="count-pill">{{ workspaces.length }} 个工作区</span>
        </div>
        <p v-if="releaseMrError" class="release-data-error" role="status">{{ releaseMrError }}</p>
        <div v-if="workspacesLoading" class="empty-compact">正在加载工作区…</div>
        <div v-else-if="!workspaces.length" class="empty-state"><strong>还没有工作区</strong><p>请先在「工作区」页创建工作区；发布页按工作区列出可构建的项目。</p></div>
        <div v-else class="release-workspace-list">
          <article v-for="workspace in workspaces" :key="workspace.name" class="release-workspace">
            <div class="release-workspace-head">
              <div class="release-workspace-title">
                <strong>{{ workspace.name }}</strong>
                <span class="count-pill">{{ workspace.projects.length }} 个项目</span>
                <span v-if="workspace.missingProjects.length" class="tag tag-danger">{{ workspace.missingProjects.length }} 个目录缺失</span>
              </div>
              <div class="release-workspace-actions">
                <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
                  <span>
                    <el-button
                      size="small"
                      type="primary"
                      plain
                      :disabled="!buildAllowed || buildingApps.length > 0"
                      @click="requestWorkspaceBuild(workspace.name)"
                    >构建此工作区全部</el-button>
                  </span>
                </el-tooltip>
                <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
                  <span>
                    <el-button
                      size="small"
                      plain
                      :disabled="!buildAllowed || releaseMrCreating.length > 0"
                      :loading="releaseMrCreating.some((key) => key.startsWith(workspace.name + '/'))"
                      @click="createReleaseMr(workspace.name)"
                    >批量创建 MR</el-button>
                  </span>
                </el-tooltip>
              </div>
            </div>
            <div class="release-project-table">
              <div class="release-project-head">
                <span>项目</span><span>DevOps 应用</span><span>检出分支（MR 源）</span><span>操作</span>
              </div>
              <div v-for="project in workspace.projects" :key="project.name" class="release-project-row">
                <div class="release-project-name">
                  <strong>{{ project.name }}</strong>
                </div>
                <div class="release-project-app">
                  <code>{{ devopsAppOf(project.name) }}</code>
                  <small>{{ devopsGroupOf(project.name) }}</small>
                </div>
                <code class="release-project-branch">{{ project.branch || '未知' }}</code>
                <div class="release-project-actions">
                  <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
                    <span>
                      <el-button
                        size="small"
                        :loading="isAppBuilding(devopsAppOf(project.name))"
                        :disabled="!buildAllowed || buildingApps.length > 0"
                        @click="requestSingleBuild(workspace.name, project.name)"
                      >构建</el-button>
                    </span>
                  </el-tooltip>
                  <el-tooltip :disabled="buildAllowed && !!project.branch" :content="!project.branch ? '未读取到检出分支，无法创建 MR' : buildBlockReason" placement="bottom">
                    <span>
                      <el-button
                        size="small"
                        plain
                        :loading="releaseMrCreating.includes(mrKey(workspace.name, project.name))"
                        :disabled="!buildAllowed || !project.branch || releaseMrCreating.length > 0"
                        @click="createReleaseMr(workspace.name, [project.name])"
                      >创建 MR</el-button>
                    </span>
                  </el-tooltip>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

  <!-- 构建二次确认：逐项列出应用/分支/build_other，写清副作用后才允许提交 -->
  <el-dialog
    v-model="buildConfirmOpen"
    :title="`确认构建 · ${selectedBuildEnv}`"
    width="min(680px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="buildingApps.length === 0"
  >
    <p class="release-confirm-intro">将对下列 {{ buildConfirmItems.length }} 个应用触发 <code>{{ selectedBuildEnv }}</code> 构建：分支 <code>{{ branchOfEnv(selectedBuildEnv) }}</code>，build_other <code>{{ buildOtherOf(selectedBuildEnv) }}</code>。构建为不可逆写操作，提交后会等待 DevOps 真实回执。</p>
    <div class="release-confirm-list">
      <div v-for="item in buildConfirmItems" :key="`${item.workspace}/${item.app}`" class="release-confirm-row">
        <div class="release-confirm-target">
          <strong>{{ item.app }}</strong>
          <small>{{ item.workspace }} / {{ item.project }} · {{ item.group }}</small>
        </div>
        <span v-if="buildOutcomes.find((outcome) => outcome.app === item.app)?.ok" class="tag tag-success">已提交</span>
        <span v-else-if="buildOutcomes.find((outcome) => outcome.app === item.app)?.ok === false" class="tag tag-danger">失败</span>
        <span v-else-if="isAppBuilding(item.app)" class="tag tag-warning">提交中</span>
        <span v-else class="tag">待提交</span>
      </div>
    </div>
    <p v-for="outcome in buildOutcomes.filter((item) => !item.ok)" :key="outcome.app" class="release-confirm-error" role="alert">{{ outcome.app }}：{{ outcome.message }}</p>
    <template #footer>
      <el-button :disabled="buildingApps.length > 0" @click="buildConfirmOpen = false">{{ buildOutcomes.length ? '关闭' : '取消' }}</el-button>
      <el-button type="primary" :loading="buildingApps.length > 0" :disabled="!canSubmitBuild" @click="submitBuilds">确认构建</el-button>
    </template>
  </el-dialog>


  <!-- 创建 MR 结果：列出 MR 链接，支持新窗口打开 -->
  <el-dialog
    v-model="releaseMrDialogOpen"
    title="合并请求已处理"
    width="min(560px, 94vw)"
  >
    <p class="release-mr-intro">下列项目的合并请求已处理完成，点击链接在新窗口打开。</p>
    <div class="release-mr-list">
      <div v-for="item in releaseMrDialogItems" :key="item.project" class="release-mr-row">
        <div class="release-mr-target">
          <strong>{{ item.project }}</strong>
          <small>{{ item.sourceBranch || '未知分支' }} → {{ item.targetBranch }}</small>
        </div>
        <span class="tag" :class="releaseMrStatusClass(item.status)">{{ releaseMrStatusLabel(item.status) }}</span>
        <a
          v-if="item.webUrl"
          :href="item.webUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="release-mr-link"
        >打开 MR ↗</a>
        <span v-else class="release-unknown">无链接</span>
      </div>
    </div>
    <template #footer>
      <el-button type="primary" @click="releaseMrDialogOpen = false">关闭</el-button>
    </template>
  </el-dialog>

</template>
