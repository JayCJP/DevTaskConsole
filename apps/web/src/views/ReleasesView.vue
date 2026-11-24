<script setup lang="ts">
/**
 * releases 页面视图（发布工作台）。
 * 合并了原工作区页的全部能力：工作区管理、详情抽屉、源系统映射、新建/删除工作区。
 * 共享状态由 ConsoleShell 通过 provide 下发。
 */
import { computed } from 'vue'
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  // 发布门控与环境
  releaseGatePhase,
  buildBlockReason,
  branchOfEnv,
  selectedBuildEnv,
  buildOtherOf,
  envSpecOf,
  buildEnvironments,
  selectBuildEnv,
  buildAllowed,
  buildingApps,
  // 工作区数据
  workspaces,
  workspacesLoading,
  workspacesError,
  refreshWorkspaces,
  formatWorkspaceTime,
  // 构建
  buildConfirmItems,
  buildOutcomes,
  requestWorkspaceBuild,
  requestSingleBuild,
  isAppBuilding,
  // 批量发布
  deployText,
  deployConfirmOpen,
  deployParsedUrls,
  deploySubmitting,
  deployOutcome,
  deployAllowed,
  requestDeploy,
  submitDeploy,
  buildConfirmOpen,
  canSubmitBuild,
  submitBuilds,
  // 发布 MR
  releaseMrError,
  releaseMrCreating,
  releaseMrDialogOpen,
  releaseMrDialogItems,
  releaseMrStatusLabel,
  releaseMrStatusClass,
  createReleaseMr,
  mrKey,
  devopsAppOf,
  devopsGroupOf,
  // 工作区详情抽屉与 MR
  selectedWorkspace,
  workspaceDetailOpen,
  openWorkspaceDetail,
  workspaceMergeRequestError,
  workspaceMergeRequestResult,
  mergeRequestStatusLabel,
  mergeRequestStatusClass,
  mrTargetBranch,
  mrBusy,
  mergeRequestTargetBranches,
  mrBatchRunning,
  mrCreatingProjects,
  createWorkspaceMergeRequest,
  // 新建工作区
  openCreateDialog,
  candidatesLoading,
  candidatesError,
  createDialogOpen,
  beforeCreateDialogClose,
  workspaceName,
  branch,
  baseBranch,
  selectedRepositoryNames,
  repositoryCandidates,
  selectedRepositoryLabel,
  workspaceTapdInput,
  workspaceTapdTitle,
  skipInstall,
  skipGraphify,
  workspaceBusy,
  workspaceError,
  workspaceJob,
  workspaceLogs,
  closeCreateDialog,
  canResumeWorkspaceJob,
  resumeWorkspaceJob,
  previewWorkspace,
  startWorkspace,
  // 源系统映射
  mappingsError,
  refreshRepositoryCandidates,
  openMappingDialog,
  mappingRows,
  mappingRemoving,
  removeApplicationMapping,
  showNoRepositoryHint,
  mappingDialogOpen,
  mappingDialogTitle,
  closeMappingDialog,
  mappingForm,
  mappingEditingRepo,
  mappingRepoOptions,
  loadMappingProjectOptions,
  mappingProjectsLoading,
  mappingProjectOptions,
  mappingSaving,
  canSubmitMappingForm,
  submitMappingForm,
  mappingFormError,
  defaultDevOpsGroup,
  // 删除工作区
  openDeleteDialog,
  workspacePendingDelete,
  deleteConfirmationPhrase,
  deleteDialogOpen,
  closeDeleteDialog,
  deleteConfirmText,
  deleting,
  canConfirmDelete,
  confirmDeleteWorkspace,
  deleteError,
  deleteResult,
} = useConsoleContext()

/**
 * 批量发布 textarea 的占位提示：一行说明，多个链接换行输入。
 */
const deployPlaceholder = '每行输入一个制品链接'

/**
 * 批量发布卡片副标题：合并输入说明、当前环境与不支持提示。
 * @returns 副标题文案
 */
const deployHint = computed(() => {
  const base = `每行一个制品链接，发布到 ${selectedBuildEnv.value} 环境`
  return deployAllowed.value
    ? `${base}。`
    : `${base}；当前环境不支持批量发布，仅 dev / pre / pre-txnj 支持。`
})

/**
 * 刷新发布页数据：工作区列表与仓库候选一起重取，口径与原工作区页刷新按钮一致。
 * @returns Promise<void>
 */
async function refreshAll(): Promise<void> {
  await Promise.all([refreshWorkspaces(), refreshRepositoryCandidates()])
}
</script>

<template>
  <!-- 护栏横幅：门控 / 通道不可用，状态同时用色与文字表达 -->
  <div
    v-if="buildBlockReason"
    class="release-guard"
    :class="releaseGatePhase !== undefined ? 'is-danger' : 'is-warning'"
    role="alert"
  >
    <svg class="release-guard-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.5 1.7 16.4a1 1 0 0 0 .87 1.5h15a1 1 0 0 0 .87-1.5L10 2.5Zm0 4.2a1 1 0 0 1 1 1v4.1a1 1 0 1 1-2 0V7.7a1 1 0 0 1 1-1Zm0 8.3a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3Z"
        fill="currentColor"
      />
    </svg>
    <div>
      <strong>{{
        releaseGatePhase !== undefined ? 'Harness 发布窗口已锁定' : 'DevOps 通道不可用'
      }}</strong>
      <p>{{ buildBlockReason }}</p>
    </div>
  </div>

  <!-- 发射控制条：环境分段器 + 固定分支/build_other 展示 -->
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
          <span
            >构建分支 <code>{{ branchOfEnv(selectedBuildEnv) }}</code></span
          >
          <span
            >build_other <code>{{ buildOtherOf(selectedBuildEnv) }}</code></span
          >
          <span
            >MR 目标 <code>{{ envSpecOf(selectedBuildEnv).mrTargetBranch }}</code></span
          >
        </div>
      </div>
    </div>
  </section>

  <!-- 批量发布：textarea 输入多个制品链接，复用顶部所选环境 -->
  <section class="surface release-batch-deploy">
    <div class="section-heading">
      <div>
        <h2>批量发布</h2>
        <p class="deploy-hint">{{ deployHint }}</p>
      </div>
    </div>
    <div class="deploy-input-wrap">
      <el-input
        v-model="deployText"
        type="textarea"
        :rows="5"
        class="deploy-textarea"
        :placeholder="deployPlaceholder"
      />
      <el-button
        class="deploy-inner-button"
        type="primary"
        :loading="deploySubmitting"
        :disabled="!deployAllowed || deploySubmitting"
        @click="requestDeploy"
        >发布</el-button
      >
    </div>
    <section v-if="deployOutcome" class="deploy-outcome">
      <div class="deploy-outcome-head">
        <strong>发布回执</strong>
        <span class="tag" :class="deployOutcome.ok ? 'tag-success' : 'tag-danger'">{{
          deployOutcome.ok ? '已提交' : '失败'
        }}</span>
        <span class="muted">环境 {{ deployOutcome.env }}</span>
      </div>
      <p>{{ deployOutcome.message }}</p>
      <ul class="deploy-url-list">
        <li v-for="url in deployOutcome.urls" :key="url">
          <code>{{ url }}</code>
        </li>
      </ul>
      <details v-if="deployOutcome.raw !== undefined" class="deploy-raw">
        <summary>查看 DevOps 原始回执</summary>
        <pre>{{ JSON.stringify(deployOutcome.raw, null, 2) }}</pre>
      </details>
    </section>
  </section>

  <!-- 批量发布二次确认：逐条列出待发布制品 -->
  <el-dialog
    v-model="deployConfirmOpen"
    title="确认批量发布"
    width="min(640px, 94vw)"
    :close-on-click-modal="false"
  >
    <p class="release-confirm-intro">
      将把下列 {{ deployParsedUrls.length }} 个制品发布到
      <code>{{ selectedBuildEnv }}</code> 环境。发布为不可逆写操作，提交后等待 DevOps
      真实回执；请求被接受不代表已上线。
    </p>
    <ul class="deploy-confirm-list">
      <li v-for="url in deployParsedUrls" :key="url">
        <code>{{ url }}</code>
      </li>
    </ul>
    <template #footer>
      <el-button :disabled="deploySubmitting" @click="deployConfirmOpen = false">取消</el-button>
      <el-button type="primary" :loading="deploySubmitting" @click="submitDeploy"
        >确认发布</el-button
      >
    </template>
  </el-dialog>

  <!-- 工作区管理：新建 / 刷新 / 项目清单，工作区维度带删除入口 -->
  <section class="surface">
    <div class="section-heading">
      <div>
        <h2>工作区项目</h2>
        <p>构建分支与 build_other 由顶部所选环境统一决定；MR 源分支取项目当前检出分支。</p>
      </div>
      <div class="workspace-actions">
        <el-button :loading="workspacesLoading" @click="refreshAll()">刷新</el-button>
        <el-button type="primary" @click="openCreateDialog">新建工作区</el-button>
      </div>
    </div>
    <p v-if="workspacesError" class="mapping-error" role="alert">{{ workspacesError }}</p>
    <p v-if="releaseMrError" class="release-data-error" role="status">{{ releaseMrError }}</p>
    <div v-if="workspacesLoading" class="empty-compact">正在加载工作区…</div>
    <div v-else-if="!workspaces.length" class="empty-state">
      <strong>还没有工作区</strong>
      <p>点击「新建工作区」，选择多个项目后会自动创建 git worktree 与 .code-workspace 文件。</p>
    </div>
    <div v-else class="release-workspace-list">
      <article v-for="workspace in workspaces" :key="workspace.name" class="release-workspace">
        <div class="release-workspace-head">
          <div class="release-workspace-title">
            <strong>{{ workspace.name }}</strong>
            <span class="count-pill">{{ workspace.projects.length }} 个项目</span>
            <span v-if="workspace.missingProjects.length" class="tag tag-danger"
              >{{ workspace.missingProjects.length }} 个目录缺失</span
            >
          </div>
          <div class="release-workspace-actions">
            <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
              <span>
                <el-button
                  size="small"
                  plain
                  :disabled="!buildAllowed || buildingApps.length > 0"
                  @click="requestWorkspaceBuild(workspace.name)"
                  >批量构建</el-button
                >
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
                  >批量创建 MR</el-button
                >
              </span>
            </el-tooltip>
            <el-button size="small" @click="openWorkspaceDetail(workspace)">查看详情</el-button>
            <el-button size="small" type="danger" plain @click="openDeleteDialog(workspace)"
              >删除工作区</el-button
            >
          </div>
        </div>
        <div class="release-project-table">
          <div class="release-project-head">
            <span>项目</span><span>DevOps 应用</span><span>检出分支（MR 源）</span><span>操作</span>
          </div>
          <div
            v-for="project in workspace.projects"
            :key="project.name"
            class="release-project-row"
          >
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
                    >构建</el-button
                  >
                </span>
              </el-tooltip>
              <el-tooltip
                :disabled="buildAllowed && !!project.branch"
                :content="!project.branch ? '未读取到检出分支，无法创建 MR' : buildBlockReason"
                placement="bottom"
              >
                <span>
                  <el-button
                    size="small"
                    plain
                    :loading="releaseMrCreating.includes(mrKey(workspace.name, project.name))"
                    :disabled="!buildAllowed || !project.branch || releaseMrCreating.length > 0"
                    @click="createReleaseMr(workspace.name, [project.name])"
                    >创建 MR</el-button
                  >
                </span>
              </el-tooltip>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>

  <!-- 源系统映射 -->
  <section class="surface">
    <div class="section-heading">
      <div>
        <h2>源系统映射</h2>
        <p>
          一份默认规则覆盖所有同名仓库；下方只列出人工确认的差异映射，GitLab 搜索结果不会自动采用。
        </p>
      </div>
      <div class="mapping-head-actions">
        <el-button :loading="candidatesLoading" @click="refreshRepositoryCandidates()"
          >刷新</el-button
        >
        <el-button type="primary" @click="openMappingDialog()">新增映射</el-button>
      </div>
    </div>
    <div v-if="candidatesError" class="notice notice-warning" role="status">
      <span class="notice-symbol">!</span>
      <div>
        <strong>无法扫描仓库</strong>
        <p>{{ candidatesError }}</p>
      </div>
    </div>
    <p v-if="mappingsError" class="notice notice-warning" role="alert">{{ mappingsError }}</p>
    <div class="mapping-table">
      <div class="mapping-table-head">
        <span>Git 仓库</span><span>GitLab 项目</span><span>DevOps 应用</span><span>DevOps 分组</span
        ><span>操作</span>
      </div>
      <div
        v-for="row in mappingRows"
        :key="row.key"
        class="mapping-table-row"
        :class="{ 'is-default': row.isDefault }"
      >
        <strong>{{ row.repoName }}</strong>
        <span
          v-for="cell in row.cells"
          :key="cell.key"
          class="mapping-cell"
          :class="{ 'is-changed': cell.changed }"
          >{{ cell.value }}</span
        >
        <div class="mapping-row-actions">
          <span v-if="row.isDefault" class="tag tag-success">默认规则</span>
          <template v-else>
            <el-button link size="small" @click="openMappingDialog(row.repoName)">编辑</el-button>
            <el-button
              link
              size="small"
              type="danger"
              :loading="mappingRemoving === row.repoName"
              @click="removeApplicationMapping(row.repoName)"
              >恢复默认</el-button
            >
          </template>
        </div>
      </div>
    </div>
    <p v-if="mappingRows.length === 1" class="mapping-footnote">
      当前没有差异映射，所有仓库沿用上方默认规则。
    </p>
    <p v-if="showNoRepositoryHint" class="mapping-footnote">
      未发现 Git 仓库，仍可手动输入仓库名新增映射。
    </p>
  </section>

  <!-- 工作区详情抽屉：展示项目列表与工作区维度 MR -->
  <el-drawer
    v-model="workspaceDetailOpen"
    title="工作区详情"
    size="min(640px, 94vw)"
    @close="selectedWorkspace = null"
  >
    <template v-if="selectedWorkspace">
      <p class="eyebrow">WORKSPACE</p>
      <h2>{{ selectedWorkspace.name }}</h2>
      <div class="detail-grid">
        <span>目录</span><code>{{ selectedWorkspace.path }}</code> <span>工作区文件</span
        ><code>{{ selectedWorkspace.workspaceFile || '缺少 .code-workspace' }}</code>
        <span>更新时间</span><strong>{{ formatWorkspaceTime(selectedWorkspace.updatedAt) }}</strong>
        <span>项目数</span><strong>{{ selectedWorkspace.projects.length }}</strong>
      </div>
      <section class="workspace-mr">
        <div class="workspace-mr-head">
          <div>
            <h3>创建合并请求</h3>
            <p class="muted">
              源分支取项目当前检出的分支，目标分支可在下方选择；此处按工作区维度创建
              MR，不绑定发布环境（上方项目行的 MR 使用顶部所选环境的 MR 目标）。只创建
              MR，不推送代码、不删除分支。
            </p>
          </div>
          <div class="workspace-mr-controls">
            <el-select
              v-model="mrTargetBranch"
              size="small"
              :disabled="mrBusy"
              aria-label="合并目标分支"
            >
              <el-option
                v-for="branchName in mergeRequestTargetBranches"
                :key="branchName"
                :label="branchName"
                :value="branchName"
              />
            </el-select>
            <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
              <span>
                <el-button
                  type="primary"
                  size="small"
                  :loading="mrBatchRunning"
                  :disabled="!buildAllowed || !selectedWorkspace.projects.length || mrBusy"
                  @click="createWorkspaceMergeRequest()"
                >
                  一键创建 {{ selectedWorkspace.projects.length }} 个项目
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </div>
        <p v-if="workspaceMergeRequestError" class="mapping-error" role="status">
          {{ workspaceMergeRequestError }}
        </p>
        <ul v-if="workspaceMergeRequestResult" class="workspace-mr-result">
          <li v-for="item in workspaceMergeRequestResult.items" :key="item.project">
            <span class="tag" :class="mergeRequestStatusClass(item.status)">{{
              mergeRequestStatusLabel(item.status)
            }}</span>
            <strong>{{ item.project }}</strong>
            <span class="muted"
              >{{ item.sourceBranch || '未知分支' }} → {{ item.targetBranch }}</span
            >
            <a v-if="item.webUrl" :href="item.webUrl" target="_blank" rel="noreferrer">
              {{ item.mergeRequestIid ? `!${item.mergeRequestIid}` : '打开 MR' }}
            </a>
            <span v-else-if="item.message" class="muted">{{ item.message }}</span>
          </li>
        </ul>
      </section>
      <section class="bug-detail-list">
        <h3>包含的项目</h3>
        <article
          v-for="project in selectedWorkspace.projects"
          :key="project.path"
          class="bug-detail"
        >
          <div class="inbox-title-line">
            <strong>{{ project.name }}</strong>
            <span class="tag" :class="project.worktree ? 'tag-success' : 'tag-warning'">{{
              project.worktree ? 'worktree' : '独立目录'
            }}</span>
          </div>
          <p>
            <code>{{ project.path }}</code>
          </p>
          <div class="workspace-project-foot">
            <span class="muted"
              >当前分支：{{ project.branch || '未知' }}（按工作区维度建 MR，不绑定发布环境）</span
            >
            <el-tooltip :disabled="buildAllowed" :content="buildBlockReason" placement="bottom">
              <span>
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :loading="mrCreatingProjects.includes(project.name)"
                  :disabled="!buildAllowed || mrBusy || !project.branch"
                  @click="createWorkspaceMergeRequest([project.name])"
                >
                  创建 MR
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </article>
        <p v-if="!selectedWorkspace.projects.length" class="muted">该工作区目录下没有 git 项目。</p>
      </section>
      <section v-if="selectedWorkspace.missingProjects.length" class="bug-detail-list">
        <h3>工作区文件声明但目录缺失</h3>
        <p class="muted">{{ selectedWorkspace.missingProjects.join('、') }}</p>
      </section>
    </template>
    <template #footer>
      <el-button @click="selectedWorkspace = null">关闭</el-button>
    </template>
  </el-drawer>

  <!-- 新建工作区 -->
  <el-dialog
    v-model="createDialogOpen"
    title="新建工作区"
    width="min(760px, 94vw)"
    :close-on-click-modal="false"
    :before-close="beforeCreateDialogClose"
  >
    <div class="workspace-form">
      <label
        >工作区名<el-input
          v-model="workspaceName"
          placeholder="ASCII 字母、数字、点、下划线或连字符"
      /></label>
      <label>分支名<el-input v-model="branch" placeholder="默认 feat/&lt;工作区名&gt;" /></label>
      <label>基线分支<el-input v-model="baseBranch" placeholder="默认 master" /></label>
      <label class="workspace-form-wide">
        <span class="workspace-form-candidates-head">
          项目（可搜索、可多选）· {{ selectedRepositoryLabel }}
          <el-button
            class="workspace-candidates-refresh"
            size="small"
            text
            :loading="candidatesLoading"
            @click="refreshRepositoryCandidates(true)"
            >刷新</el-button
          >
        </span>
        <el-select
          v-model="selectedRepositoryNames"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          :loading="candidatesLoading"
          placeholder="搜索并选择要加入工作区的项目"
        >
          <el-option
            v-for="candidate in repositoryCandidates"
            :key="candidate.path"
            :label="candidate.name"
            :value="candidate.name"
          >
            <span>{{ candidate.name }}</span>
            <small class="option-hint">{{ candidate.path }}</small>
          </el-option>
        </el-select>
        <p v-if="showNoRepositoryHint" class="workspace-form-tapd-hint">
          未发现可选项目：请到「连接与配置」检查「源仓库根目录」，确认该目录含 .git
          的子项目后点「保存配置」。
        </p>
      </label>
      <div class="workspace-form-tapd">
        <label
          >TAPD 需求链接或 ID（可选）
          <el-input
            v-model="workspaceTapdInput"
            placeholder="https://www.tapd.cn/.../view/1138... 或纯数字 ID；留空则不绑定"
          />
        </label>
        <label
          >需求名称（可选）
          <el-input v-model="workspaceTapdTitle" placeholder="TAPD 查询不到需求标题时用于展示" />
        </label>
        <p class="workspace-form-tapd-hint">
          填写链接后，工作区创建完成会自动绑定到对应 TAPD 需求；子需求链接会归到其父需求。
        </p>
      </div>
      <div class="workspace-form-checks">
        <el-checkbox v-model="skipInstall">跳过 npm install</el-checkbox>
        <el-checkbox v-model="skipGraphify">跳过 graphify</el-checkbox>
      </div>
    </div>
    <div class="notice">
      <span class="notice-symbol">i</span>
      <div>
        <strong>只创建选中的项目</strong>
        <p>
          正式创建会基于基线分支新建需求分支，把每个项目以 git worktree 检出到工作区目录，并写入
          &lt;工作区名&gt;.code-workspace；不会 git pull、提交或删除远程分支。
        </p>
      </div>
    </div>
    <div v-if="workspaceError" class="notice notice-warning" role="status">
      <span class="notice-symbol">!</span>
      <div>
        <strong>工作区任务异常</strong>
        <p>{{ workspaceError }}</p>
      </div>
    </div>
    <section v-if="workspaceLogs.length || workspaceJob" class="workspace-output">
      <div class="section-heading">
        <div>
          <h3>
            {{
              workspaceJob
                ? `初始化：${workspaceJob.status} · ${workspaceJob.stage}`
                : 'DryRun 结果'
            }}
          </h3>
          <p>DryRun 不执行文件或 Git 写入；正式执行的日志会持续刷新。</p>
        </div>
        <span
          v-if="workspaceJob?.exitCode !== null && workspaceJob?.exitCode !== undefined"
          class="tag"
          :class="workspaceJob.exitCode === 0 ? 'tag-success' : 'tag-danger'"
          >exit {{ workspaceJob.exitCode }}</span
        >
      </div>
      <pre>{{ workspaceLogs.join('\n') || '正在等待输出…' }}</pre>
    </section>
    <template #footer>
      <el-button :disabled="workspaceBusy" @click="closeCreateDialog">关闭</el-button>
      <el-button v-if="canResumeWorkspaceJob" :disabled="workspaceBusy" @click="resumeWorkspaceJob">
        从记录阶段续跑
      </el-button>
      <el-button
        :loading="candidatesLoading"
        :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceBusy"
        @click="previewWorkspace"
        >DryRun 预演</el-button
      >
      <el-button
        type="primary"
        :loading="workspaceBusy"
        :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceBusy"
        @click="startWorkspace"
        >确认并创建</el-button
      >
    </template>
  </el-dialog>

  <!-- 源系统映射：新增 / 编辑差异映射 -->
  <el-dialog
    v-model="mappingDialogOpen"
    :title="mappingDialogTitle"
    width="min(600px, 94vw)"
    :close-on-click-modal="false"
    @close="closeMappingDialog"
  >
    <div class="mapping-form">
      <label class="mapping-control">
        <span>Git 仓库名</span>
        <el-select
          v-model="mappingForm.repoName"
          filterable
          allow-create
          default-first-option
          :disabled="mappingEditingRepo !== null"
          placeholder="选择仓库，或输入名称后回车"
        >
          <el-option v-for="name in mappingRepoOptions" :key="name" :label="name" :value="name" />
        </el-select>
      </label>
      <label class="mapping-control">
        <span>GitLab 项目（输入关键字搜索，留空沿用默认）</span>
        <el-select
          v-model="mappingForm.gitlabProjectId"
          filterable
          clearable
          remote
          reserve-keyword
          :remote-method="loadMappingProjectOptions"
          :loading="mappingProjectsLoading"
          placeholder="留空 = 按仓库名精确匹配"
        >
          <el-option
            v-for="project in mappingProjectOptions"
            :key="project.id"
            :label="project.pathWithNamespace"
            :value="project.id"
          />
        </el-select>
      </label>
      <label class="mapping-control">
        <span>DevOps 应用</span>
        <el-input
          v-model="mappingForm.devopsApp"
          :placeholder="`${mappingForm.repoName || '仓库名'}（留空沿用同名默认）`"
        />
      </label>
      <label class="mapping-control">
        <span>DevOps 分组</span>
        <el-input v-model="mappingForm.devopsGroup" :placeholder="defaultDevOpsGroup" />
      </label>
    </div>
    <p class="mapping-hint">
      默认规则：git 仓库名 = DevOps 应用名、分组 = {{ defaultDevOpsGroup }}、GitLab
      按仓库名精确匹配。只有与默认不一致的字段才会保存，搜索结果仅作候选，不会自动采用。
    </p>
    <p v-if="mappingFormError" class="mapping-error" role="alert">{{ mappingFormError }}</p>
    <template #footer>
      <el-button @click="closeMappingDialog()">取消</el-button>
      <el-button
        type="primary"
        :loading="mappingSaving"
        :disabled="!canSubmitMappingForm"
        @click="submitMappingForm()"
        >保存映射</el-button
      >
    </template>
  </el-dialog>

  <!-- 删除工作区：必须输入“确认删除” -->
  <el-dialog
    v-model="deleteDialogOpen"
    title="删除工作区"
    width="min(600px, 94vw)"
    :close-on-click-modal="false"
    @close="closeDeleteDialog"
  >
    <template v-if="workspacePendingDelete">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="删除后不可恢复"
        description="将执行 git worktree remove 并删除工作区目录；不会删除本地分支，也不会删除远程分支。"
      />
      <div class="detail-grid">
        <span>工作区</span><strong>{{ workspacePendingDelete.name }}</strong> <span>目录</span
        ><code>{{ workspacePendingDelete.path }}</code> <span>项目</span
        ><strong>{{
          workspacePendingDelete.projects.map((project) => project.name).join('、') || '无'
        }}</strong>
      </div>
      <label class="delete-confirm-field">
        <span>请输入「{{ deleteConfirmationPhrase }}」以确认删除</span>
        <el-input v-model="deleteConfirmText" :placeholder="deleteConfirmationPhrase" />
      </label>
      <p v-if="deleteError" class="mapping-error" role="alert">{{ deleteError }}</p>
      <section v-if="deleteResult" class="workspace-output">
        <div class="section-heading">
          <div>
            <h3>删除结果</h3>
            <p>
              已移除 {{ deleteResult.removedWorktrees.length }} 个 worktree 登记，删除
              {{ deleteResult.removedDirectories.length }} 个目录。
            </p>
          </div>
        </div>
        <pre>{{ deleteResult.logs.join('\n') }}</pre>
        <p v-if="deleteResult.warnings.length" class="mapping-error">
          {{ deleteResult.warnings.join('；') }}
        </p>
      </section>
    </template>
    <template #footer>
      <el-button :disabled="deleting" @click="closeDeleteDialog">{{
        deleteResult ? '关闭' : '取消'
      }}</el-button>
      <el-button
        type="danger"
        :loading="deleting"
        :disabled="!canConfirmDelete || deleting || Boolean(deleteResult)"
        @click="confirmDeleteWorkspace"
        >确认删除</el-button
      >
    </template>
  </el-dialog>

  <!-- 构建二次确认 -->
  <el-dialog
    v-model="buildConfirmOpen"
    :title="`确认构建 · ${selectedBuildEnv}`"
    width="min(680px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="buildingApps.length === 0"
  >
    <p class="release-confirm-intro">
      将对下列 {{ buildConfirmItems.length }} 个应用触发
      <code>{{ selectedBuildEnv }}</code> 构建：分支
      <code>{{ branchOfEnv(selectedBuildEnv) }}</code>，build_other
      <code>{{ buildOtherOf(selectedBuildEnv) }}</code>。构建为不可逆写操作，提交后会等待 DevOps
      真实回执。
    </p>
    <div class="release-confirm-list">
      <div
        v-for="item in buildConfirmItems"
        :key="`${item.workspace}/${item.app}`"
        class="release-confirm-row"
      >
        <div class="release-confirm-target">
          <strong>{{ item.app }}</strong>
          <small>{{ item.workspace }} / {{ item.project }} · {{ item.group }}</small>
        </div>
        <span
          v-if="buildOutcomes.find((outcome) => outcome.app === item.app)?.ok"
          class="tag tag-success"
          >已提交</span
        >
        <span
          v-else-if="buildOutcomes.find((outcome) => outcome.app === item.app)?.ok === false"
          class="tag tag-danger"
          >失败</span
        >
        <span v-else-if="isAppBuilding(item.app)" class="tag tag-warning">提交中</span>
        <span v-else class="tag">待提交</span>
      </div>
    </div>
    <p
      v-for="outcome in buildOutcomes.filter((item) => !item.ok)"
      :key="outcome.app"
      class="release-confirm-error"
      role="alert"
    >
      {{ outcome.app }}：{{ outcome.message }}
    </p>
    <template #footer>
      <el-button :disabled="buildingApps.length > 0" @click="buildConfirmOpen = false">{{
        buildOutcomes.length ? '关闭' : '取消'
      }}</el-button>
      <el-button
        type="primary"
        :loading="buildingApps.length > 0"
        :disabled="!canSubmitBuild"
        @click="submitBuilds"
        >确认构建</el-button
      >
    </template>
  </el-dialog>

  <!-- 创建 MR 结果 -->
  <el-dialog v-model="releaseMrDialogOpen" title="合并请求已处理" width="min(560px, 94vw)">
    <p class="release-mr-intro">下列项目的合并请求已处理完成，点击链接在新窗口打开。</p>
    <div class="release-mr-list">
      <div v-for="item in releaseMrDialogItems" :key="item.project" class="release-mr-row">
        <div class="release-mr-target">
          <strong>{{ item.project }}</strong>
          <small>{{ item.sourceBranch || '未知分支' }} → {{ item.targetBranch }}</small>
        </div>
        <span class="tag" :class="releaseMrStatusClass(item.status)">{{
          releaseMrStatusLabel(item.status)
        }}</span>
        <a
          v-if="item.webUrl"
          :href="item.webUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="release-mr-link"
          >打开 MR ↗</a
        >
        <span v-else class="release-unknown">无链接</span>
      </div>
    </div>
    <template #footer>
      <el-button type="primary" @click="releaseMrDialogOpen = false">关闭</el-button>
    </template>
  </el-dialog>
</template>
