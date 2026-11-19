<script setup lang="ts">
/**
 * workspaces 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  defaultDevOpsGroup,
  workspacesError,
  formatWorkspaceTime,
  candidatesError,
  mappingsError,
  selectedWorkspace,
  workspaceMergeRequestError,
  mergeRequestStatusLabel,
  selectedRepositoryLabel,
  workspaceError,
  workspaceJob,
  workspaceLogs,
  mappingFormError,
  workspacePendingDelete,
  deleteConfirmationPhrase,
  deleteError,
  deleteResult,
  workspacesLoading,
  refreshWorkspaces,
  openCreateDialog,
  workspaces,
  openWorkspaceDetail,
  openDeleteDialog,
  candidatesLoading,
  refreshRepositoryCandidates,
  openMappingDialog,
  mappingRows,
  mappingRemoving,
  removeApplicationMapping,
  showNoRepositoryHint,
  workspaceDetailOpen,
  mrTargetBranch,
  mrBusy,
  mergeRequestTargetBranches,
  mrBatchRunning,
  createWorkspaceMergeRequest,
  workspaceMergeRequestResult,
  mergeRequestStatusClass,
  mrCreatingProjects,
  createDialogOpen,
  beforeCreateDialogClose,
  workspaceName,
  branch,
  baseBranch,
  selectedRepositoryNames,
  repositoryCandidates,
  workspaceTapdInput,
  workspaceTapdTitle,
  skipInstall,
  skipGraphify,
  workspaceBusy,
  closeCreateDialog,
  canResumeWorkspaceJob,
  resumeWorkspaceJob,
  previewWorkspace,
  startWorkspace,
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
  deleteDialogOpen,
  closeDeleteDialog,
  deleteConfirmText,
  deleting,
  canConfirmDelete,
  confirmDeleteWorkspace,
} = useConsoleContext()
</script>

<template>
      <section class="surface">
        <div class="section-heading">
          <div><h2>工作区列表</h2><p>工作区来自工作区根目录；可查看每个工作区包含的项目，或删除工作区</p></div>
          <div class="workspace-actions">
            <el-button :loading="workspacesLoading" @click="refreshWorkspaces()">刷新</el-button>
            <el-button type="primary" @click="openCreateDialog">新建工作区</el-button>
          </div>
        </div>
        <p v-if="workspacesError" class="mapping-error" role="alert">{{ workspacesError }}</p>
        <div v-if="workspaces.length" class="workspace-list">
          <article v-for="workspace in workspaces" :key="workspace.name" class="workspace-row">
            <div class="workspace-main">
              <strong>{{ workspace.name }}</strong>
              <small><code>{{ workspace.path }}</code></small>
            </div>
            <span class="count-pill">{{ workspace.projects.length }} 个项目</span>
            <span v-if="!workspace.workspaceFile" class="tag tag-warning">缺少 .code-workspace</span>
            <span v-if="workspace.missingProjects.length" class="tag tag-danger">{{ workspace.missingProjects.length }} 个目录缺失</span>
            <span class="muted">{{ formatWorkspaceTime(workspace.updatedAt) }}</span>
            <div class="workspace-row-actions">
              <el-button size="small" @click="openWorkspaceDetail(workspace)">详情</el-button>
              <el-button size="small" type="danger" plain @click="openDeleteDialog(workspace)">删除</el-button>
            </div>
          </article>
        </div>
        <div v-else-if="workspacesLoading" class="empty-compact">正在加载工作区…</div>
        <div v-else class="empty-state"><strong>还没有工作区</strong><p>点击「新建工作区」，选择多个项目后会自动创建 git worktree 与 .code-workspace 文件。</p></div>
      </section>

      <section class="surface">
        <div class="section-heading">
          <div><h2>源系统映射</h2><p>一份默认规则覆盖所有同名仓库；下方只列出人工确认的差异映射，GitLab 搜索结果不会自动采用。</p></div>
          <div class="mapping-head-actions">
            <el-button :loading="candidatesLoading" @click="refreshRepositoryCandidates()">刷新</el-button>
            <el-button type="primary" @click="openMappingDialog()">新增映射</el-button>
          </div>
        </div>
        <div v-if="candidatesError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>无法扫描仓库</strong><p>{{ candidatesError }}</p></div></div>
        <p v-if="mappingsError" class="notice notice-warning" role="alert">{{ mappingsError }}</p>
        <div class="mapping-table">
          <div class="mapping-table-head">
            <span>Git 仓库</span><span>GitLab 项目</span><span>DevOps 应用</span><span>DevOps 分组</span><span>操作</span>
          </div>
          <div v-for="row in mappingRows" :key="row.key" class="mapping-table-row" :class="{ 'is-default': row.isDefault }">
            <strong>{{ row.repoName }}</strong>
            <span v-for="cell in row.cells" :key="cell.key" class="mapping-cell" :class="{ 'is-changed': cell.changed }">{{ cell.value }}</span>
            <div class="mapping-row-actions">
              <span v-if="row.isDefault" class="tag tag-success">默认规则</span>
              <template v-else>
                <el-button link size="small" @click="openMappingDialog(row.repoName)">编辑</el-button>
                <el-button link size="small" type="danger" :loading="mappingRemoving === row.repoName" @click="removeApplicationMapping(row.repoName)">恢复默认</el-button>
              </template>
            </div>
          </div>
        </div>
        <p v-if="mappingRows.length === 1" class="mapping-footnote">当前没有差异映射，所有仓库沿用上方默认规则。</p>
        <p v-if="showNoRepositoryHint" class="mapping-footnote">未发现 Git 仓库，仍可手动输入仓库名新增映射。</p>
      </section>

  <!-- 工作区详情抽屉：展示该工作区包含哪些项目 -->
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
        <span>目录</span><code>{{ selectedWorkspace.path }}</code>
        <span>工作区文件</span><code>{{ selectedWorkspace.workspaceFile || '缺少 .code-workspace' }}</code>
        <span>更新时间</span><strong>{{ formatWorkspaceTime(selectedWorkspace.updatedAt) }}</strong>
        <span>项目数</span><strong>{{ selectedWorkspace.projects.length }}</strong>
      </div>
      <!-- 合并请求：目标分支可选，支持单项目创建与一键批量创建 -->
      <section class="workspace-mr">
        <div class="workspace-mr-head">
          <div>
            <h3>创建合并请求</h3>
            <p class="muted">源分支取项目当前检出的分支，只创建 MR，不推送代码、不删除分支。</p>
          </div>
          <div class="workspace-mr-controls">
            <el-select v-model="mrTargetBranch" size="small" :disabled="mrBusy" aria-label="合并目标分支">
              <el-option
                v-for="branchName in mergeRequestTargetBranches"
                :key="branchName"
                :label="branchName"
                :value="branchName"
              />
            </el-select>
            <el-button
              type="primary"
              size="small"
              :loading="mrBatchRunning"
              :disabled="!selectedWorkspace.projects.length || mrBusy"
              @click="createWorkspaceMergeRequest()"
            >
              一键创建 {{ selectedWorkspace.projects.length }} 个项目
            </el-button>
          </div>
        </div>
        <p v-if="workspaceMergeRequestError" class="mapping-error" role="status">{{ workspaceMergeRequestError }}</p>
        <ul v-if="workspaceMergeRequestResult" class="workspace-mr-result">
          <li v-for="item in workspaceMergeRequestResult.items" :key="item.project">
            <span class="tag" :class="mergeRequestStatusClass(item.status)">{{ mergeRequestStatusLabel(item.status) }}</span>
            <strong>{{ item.project }}</strong>
            <span class="muted">{{ item.sourceBranch || '未知分支' }} → {{ item.targetBranch }}</span>
            <a v-if="item.webUrl" :href="item.webUrl" target="_blank" rel="noreferrer">
              {{ item.mergeRequestIid ? `!${item.mergeRequestIid}` : '打开 MR' }}
            </a>
            <span v-else-if="item.message" class="muted">{{ item.message }}</span>
          </li>
        </ul>
      </section>
      <section class="bug-detail-list">
        <h3>包含的项目</h3>
        <article v-for="project in selectedWorkspace.projects" :key="project.path" class="bug-detail">
          <div class="inbox-title-line">
            <strong>{{ project.name }}</strong>
            <span class="tag" :class="project.worktree ? 'tag-success' : 'tag-warning'">{{ project.worktree ? 'worktree' : '独立目录' }}</span>
          </div>
          <p><code>{{ project.path }}</code></p>
          <div class="workspace-project-foot">
            <span class="muted">当前分支：{{ project.branch || '未知' }}</span>
            <el-button
              size="small"
              type="primary"
              plain
              :loading="mrCreatingProjects.includes(project.name)"
              :disabled="mrBusy || !project.branch"
              @click="createWorkspaceMergeRequest([project.name])"
            >
              创建 MR
            </el-button>
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


  <!-- 新建工作区：项目通过可搜索的多选下拉选择 -->
  <el-dialog
    v-model="createDialogOpen"
    title="新建工作区"
    width="min(760px, 94vw)"
    :close-on-click-modal="false"
    :before-close="beforeCreateDialogClose"
  >
    <div class="workspace-form">
      <label>工作区名<el-input v-model="workspaceName" placeholder="ASCII 字母、数字、点、下划线或连字符" /></label>
      <label>分支名<el-input v-model="branch" placeholder="默认 feat/&lt;工作区名&gt;" /></label>
      <label>基线分支<el-input v-model="baseBranch" placeholder="默认 master" /></label>
      <label class="workspace-form-wide">
        <span>项目（可搜索、可多选）· {{ selectedRepositoryLabel }}</span>
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
          <el-option v-for="candidate in repositoryCandidates" :key="candidate.path" :label="candidate.name" :value="candidate.name">
            <span>{{ candidate.name }}</span>
            <small class="option-hint">{{ candidate.path }}</small>
          </el-option>
        </el-select>
      </label>
      <!-- 可选：创建成功后把工作区绑定到 TAPD 需求；两者均留空则不绑定 -->
      <div class="workspace-form-tapd">
        <label>TAPD 需求链接或 ID（可选）
          <el-input v-model="workspaceTapdInput" placeholder="https://www.tapd.cn/.../view/1138... 或纯数字 ID；留空则不绑定" />
        </label>
        <label>需求名称（可选）
          <el-input v-model="workspaceTapdTitle" placeholder="TAPD 查询不到需求标题时用于展示" />
        </label>
        <p class="workspace-form-tapd-hint">填写链接后，工作区创建完成会自动绑定到对应 TAPD 需求；子需求链接会归到其父需求。</p>
      </div>
      <!-- 跳步选项：el-checkbox 自身即 label，外层用 div 避免 label 嵌套 -->
      <div class="workspace-form-checks">
        <el-checkbox v-model="skipInstall">跳过 npm install</el-checkbox>
        <el-checkbox v-model="skipGraphify">跳过 graphify</el-checkbox>
      </div>
    </div>
    <div class="notice"><span class="notice-symbol">i</span><div><strong>只创建选中的项目</strong><p>正式创建会基于基线分支新建需求分支，把每个项目以 git worktree 检出到工作区目录，并写入 &lt;工作区名&gt;.code-workspace；不会 git pull、提交或删除远程分支。</p></div></div>
    <div v-if="workspaceError" class="notice notice-warning" role="status"><span class="notice-symbol">!</span><div><strong>工作区任务异常</strong><p>{{ workspaceError }}</p></div></div>
    <section v-if="workspaceLogs.length || workspaceJob" class="workspace-output">
      <div class="section-heading">
        <div><h3>{{ workspaceJob ? `初始化：${workspaceJob.status} · ${workspaceJob.stage}` : 'DryRun 结果' }}</h3><p>DryRun 不执行文件或 Git 写入；正式执行的日志会持续刷新。</p></div>
        <span v-if="workspaceJob?.exitCode !== null && workspaceJob?.exitCode !== undefined" class="tag" :class="workspaceJob.exitCode === 0 ? 'tag-success' : 'tag-danger'">exit {{ workspaceJob.exitCode }}</span>
      </div>
      <pre>{{ workspaceLogs.join('\n') || '正在等待输出…' }}</pre>
    </section>
    <template #footer>
      <el-button :disabled="workspaceBusy" @click="closeCreateDialog">关闭</el-button>
      <el-button v-if="canResumeWorkspaceJob" :disabled="workspaceBusy" @click="resumeWorkspaceJob">
        从记录阶段续跑
      </el-button>
      <el-button :loading="candidatesLoading" :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceBusy" @click="previewWorkspace">DryRun 预演</el-button>
      <el-button type="primary" :loading="workspaceBusy" :disabled="!workspaceName || !selectedRepositoryNames.length || workspaceBusy" @click="startWorkspace">确认并创建</el-button>
    </template>
  </el-dialog>


  <!-- 源系统映射：新增 / 编辑差异映射；与默认一致的仓库不需要录入 -->
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
          <el-option v-for="project in mappingProjectOptions" :key="project.id" :label="project.pathWithNamespace" :value="project.id" />
        </el-select>
      </label>
      <label class="mapping-control">
        <span>DevOps 应用</span>
        <el-input v-model="mappingForm.devopsApp" :placeholder="`${mappingForm.repoName || '仓库名'}（留空沿用同名默认）`" />
      </label>
      <label class="mapping-control">
        <span>DevOps 分组</span>
        <el-input v-model="mappingForm.devopsGroup" :placeholder="defaultDevOpsGroup" />
      </label>
    </div>
    <p class="mapping-hint">默认规则：git 仓库名 = DevOps 应用名、分组 = {{ defaultDevOpsGroup }}、GitLab 按仓库名精确匹配。只有与默认不一致的字段才会保存，搜索结果仅作候选，不会自动采用。</p>
    <p v-if="mappingFormError" class="mapping-error" role="alert">{{ mappingFormError }}</p>
    <template #footer>
      <el-button @click="closeMappingDialog()">取消</el-button>
      <el-button type="primary" :loading="mappingSaving" :disabled="!canSubmitMappingForm" @click="submitMappingForm()">保存映射</el-button>
    </template>
  </el-dialog>


  <!-- 删除工作区：必须输入“确认删除” -->
  <el-dialog v-model="deleteDialogOpen" title="删除工作区" width="min(600px, 94vw)" :close-on-click-modal="false" @close="closeDeleteDialog">
    <template v-if="workspacePendingDelete">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="删除后不可恢复"
        description="将执行 git worktree remove 并删除工作区目录；不会删除本地分支，也不会删除远程分支。"
      />
      <div class="detail-grid">
        <span>工作区</span><strong>{{ workspacePendingDelete.name }}</strong>
        <span>目录</span><code>{{ workspacePendingDelete.path }}</code>
        <span>项目</span><strong>{{ workspacePendingDelete.projects.map((project) => project.name).join('、') || '无' }}</strong>
      </div>
      <label class="delete-confirm-field">
        <span>请输入「{{ deleteConfirmationPhrase }}」以确认删除</span>
        <el-input v-model="deleteConfirmText" :placeholder="deleteConfirmationPhrase" />
      </label>
      <p v-if="deleteError" class="mapping-error" role="alert">{{ deleteError }}</p>
      <section v-if="deleteResult" class="workspace-output">
        <div class="section-heading"><div><h3>删除结果</h3><p>已移除 {{ deleteResult.removedWorktrees.length }} 个 worktree 登记，删除 {{ deleteResult.removedDirectories.length }} 个目录。</p></div></div>
        <pre>{{ deleteResult.logs.join('\n') }}</pre>
        <p v-if="deleteResult.warnings.length" class="mapping-error">{{ deleteResult.warnings.join('；') }}</p>
      </section>
    </template>
    <template #footer>
      <el-button :disabled="deleting" @click="closeDeleteDialog">{{ deleteResult ? '关闭' : '取消' }}</el-button>
      <el-button type="danger" :loading="deleting" :disabled="!canConfirmDelete || deleting || Boolean(deleteResult)" @click="confirmDeleteWorkspace">确认删除</el-button>
    </template>
  </el-dialog>

</template>
