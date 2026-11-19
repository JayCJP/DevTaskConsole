<script setup lang="ts">
/**
 * instances 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'
import InstanceStoryCard from '../components/InstanceStoryCard.vue'
import JobDetailPanel from '../components/JobDetailPanel.vue'
const {
  jobs,
  emptyWorkspaceGuides,
  jobStateLabel,
  storyServiceError,
  currentStory,
  currentServiceLabel,
  currentPortLabel,
  serviceErrorOf,
  selectedJob,
  currentJobLabel,
  currentJobSession,
  jobPrefsError,
  jobTranscript,
  jobOutput,
  storyTargetWorkspace,
  storyDraft,
  storyTapdBinding,
  storyCreateError,
  jobError,
  activeServiceEvents,
  hasServiceFailure,
  dismissServiceEvent,
  jobStateFilter,
  instanceGroups,
  selectEmptyWorkspace,
  storyServices,
  jobsByStory,
  isMainSessionSelected,
  hasSelectedJob,
  focusStory,
  isJobSelected,
  openJob,
  jobDotClass,
  snapshotLoaded,
  currentServiceDot,
  currentServiceClass,
  currentServiceUrl,
  currentService,
  startingStoryService,
  startStoryService,
  prepareJob,
  loadResumableSessions,
  stopStoryService,
  removeStoryService,
  selectedStoryId,
  currentServiceRunning,
  jobName,
  jobPrompt,
  onPromptFileChange,
  imageUploading,
  jobActionLoading,
  createJob,
  selectedResumableSession,
  resumableLoading,
  resumableSessions,
  resumeSession,
  currentJobClass,
  controlJob,
  renameDraft,
  renameJob,
  jobDetail,
  jobDetailLoading,
  jobDetailError,
  selectedJobPinned,
  jobPinSaving,
  toggleSelectedJobPin,
  useSuggestedReply,
  jobReply,
  onReplyFileChange,
  replyToJob,
  selectedEmptyGroupKey,
  cancelStoryCreate,
  storyCreating,
  submitStoryCreate,
} = useConsoleContext()
</script>

<template>
      <div v-if="activeServiceEvents.length" class="service-event-bar" role="status">
        <div
          v-for="event in activeServiceEvents"
          :key="event.id"
          class="service-event"
          :class="{ 'is-error': event.level === 'error', 'is-warning': event.level === 'warning' }"
        >
          <span class="status-dot" :class="hasServiceFailure ? 'is-error' : 'is-active'" />
          <span><strong>{{ event.storyId }}</strong> · {{ event.message }}</span>
          <small class="muted">{{ new Date(event.createdAt).toLocaleTimeString() }}</small>
          <el-button link size="small" @click="dismissServiceEvent(event.id)">关闭</el-button>
        </div>
      </div>
      <div class="split-layout">
        <section class="surface split-list">
          <div class="section-heading"><div><h2>CodeBuddy 实例</h2><p>主会话进入 Story 总览；定时 Job 子任务进入执行详情</p></div><span class="count-pill">{{ jobs.length }}</span></div>
          <div class="instance-filter">
            <el-select v-model="jobStateFilter" size="small" aria-label="筛选子任务状态">
              <el-option label="全部子任务" value="all" />
              <el-option label="进行中" value="active" />
              <el-option label="已结束" value="done" />
              <el-option label="异常" value="failed" />
            </el-select>
            <span class="muted">每 20 秒自动刷新</span>
          </div>
          <div v-for="group in instanceGroups" :key="group.key" class="workspace-block">
            <div class="workspace-block-head">
              <div class="workspace-main"><strong>{{ group.name }}</strong><small><code>{{ group.path }}</code></small></div>
              <el-button v-if="!group.stories.length" class="workspace-create-story" type="primary" size="small" plain @click="selectEmptyWorkspace(group)">新建 Story</el-button>
            </div>
            <article class="project-block">
              <div class="project-head">
                <strong>{{ group.project?.name ?? '未声明项目' }}</strong>
                <code v-if="group.project?.branch">{{ group.project?.branch }}</code>
                <small class="muted">{{ group.stories.length }} 个 Story</small>
              </div>
              <div v-if="!group.stories.length" class="project-empty">
                <span>{{ emptyWorkspaceGuides[group.key] }}</span>
              </div>
              <template v-for="requirement in group.stories" :key="requirement.storyId">
                <InstanceStoryCard
                  :story-id="requirement.storyId"
                  :title="requirement.title"
                  :workspace-path="requirement.workspacePath"
                  :service="storyServices[requirement.storyId]"
                  :job-count="jobsByStory(requirement.storyId).length"
                  :active="isMainSessionSelected(requirement.storyId)"
                  :contains-active="hasSelectedJob(requirement.storyId)"
                  :error="serviceErrorOf(requirement.storyId)"
                  @focus="focusStory(requirement.storyId)"
                />
                <div
                  v-if="jobsByStory(requirement.storyId).length"
                  class="instance-job-list"
                  :aria-label="`${requirement.title} 的定时 Job 子任务`"
                >
                  <button
                    v-for="job in jobsByStory(requirement.storyId)"
                    :key="`${job.storyId}:${job.id}`"
                    class="simple-list-row instance-job-row"
                    :class="{ 'is-selected': isJobSelected(job) }"
                    type="button"
                    :aria-pressed="isJobSelected(job)"
                    :aria-label="`打开定时 Job 子任务：${job.name}`"
                    @click="openJob(job)"
                  >
                    <span class="status-dot" :class="jobDotClass(job)" />
                    <span class="instance-job-text">
                      <strong>{{ job.name }}</strong>
                      <small>定时 Job · {{ job.id }}</small>
                    </span>
                    <code class="instance-job-state">{{ jobStateLabel(job) }}</code>
                  </button>
                </div>
              </template>
            </article>
          </div>
          <div v-if="!instanceGroups.length && !snapshotLoaded" class="empty-compact">正在加载快照…</div>
          <div v-else-if="!instanceGroups.length" class="empty-state"><strong>还没有工作区</strong><p>先在「工作区」页新建工作区，项目下的 Story 才能启动实例。</p></div>
          <p v-if="storyServiceError" class="mapping-error" role="alert">{{ storyServiceError }}</p>
        </section>
        <section class="surface instance-workspace">
          <!-- 当前上下文：多个服务同时运行时，右侧始终标明「在看哪个 Story / 哪台服务」 -->
          <div v-if="currentStory" class="instance-context" aria-label="当前 Story 上下文">
            <span class="status-dot" :class="currentServiceDot" :aria-label="`服务状态：${currentServiceLabel}`" />
            <div class="instance-context-main">
              <p class="eyebrow">CURRENT STORY</p>
              <strong>{{ currentStory.title }}</strong>
              <small><code>{{ currentStory.storyId }}</code> · {{ currentStory.workspacePath || '未关联工作区' }}</small>
            </div>
            <span class="tag" :class="currentServiceClass">{{ currentServiceLabel }}</span>
            <code class="service-port">{{ currentPortLabel }}</code>
            <a
              v-if="currentServiceUrl"
              class="instance-open"
              :href="currentServiceUrl"
              target="_blank"
              rel="noreferrer"
              title="在新窗口打开该 Story 的 CodeBuddy 实例页面"
            >
              打开服务页 ↗
            </a>
          </div>
          <!-- 服务与实例操作统一放在右侧：左侧列表只负责「选中哪个 Story」，避免卡片被按钮挤满 -->
          <div v-if="currentStory" class="instance-toolbar">
            <el-button
              v-if="currentService?.status !== 'running'"
              type="primary"
              :loading="startingStoryService === currentStory.storyId"
              @click="startStoryService(currentStory)"
            >
              启动 / 接管
            </el-button>
            <template v-else>
              <el-button type="primary" @click="prepareJob(currentStory, 'run')">需求开发</el-button>
              <el-button type="warning" plain @click="prepareJob(currentStory, 'fixbugs')">Bug 修复</el-button>
              <el-button @click="loadResumableSessions(currentStory)">恢复会话</el-button>
              <el-button plain :loading="startingStoryService === currentStory.storyId" @click="stopStoryService(currentStory.storyId)">
                停止服务
              </el-button>
            </template>
            <el-button
              type="danger"
              plain
              :disabled="currentService?.status !== 'stopped'"
              @click="removeStoryService(currentStory.storyId)"
            >
              删除映射
            </el-button>
          </div>
          <p v-if="currentStory && serviceErrorOf(currentStory.storyId)" class="mapping-error" role="alert">
            {{ serviceErrorOf(currentStory.storyId) }}
          </p>
          <template v-if="selectedStoryId && !selectedJob">
            <p class="eyebrow">NEW STORY ROUND</p><h2>新建执行轮次</h2>
            <p class="muted">
              服务已按 Story 复用，这里创建的是该服务内的一个执行轮次（独立 Job/session），不会再启动一台服务。
            </p>
            <p v-if="!currentServiceRunning" class="muted">
              该 Story 的服务尚未运行，请先点上方「启动 / 接管」，再创建轮次。
            </p>
            <div class="instance-form">
              <label class="instance-field">
                <span>实例名称</span>
                <el-input v-model="jobName" placeholder="例如：需求开发 · 第 1 轮" />
              </label>
              <label class="instance-field">
                <span>提示词</span>
                <el-input v-model="jobPrompt" type="textarea" :rows="5" placeholder="发送给 CodeBuddy 的提示词" />
              </label>
              <div class="instance-upload">
                <el-upload
                  :auto-upload="false"
                  :show-file-list="false"
                  :on-change="onPromptFileChange"
                >
                  <el-button size="small" :loading="imageUploading">上传文件并插入提示词</el-button>
                </el-upload>
                <span class="muted">文件写入 Story 项目的 .docs/&lt;storyId&gt;/ 目录</span>
              </div>
              <div class="instance-form-actions">
                <el-button type="primary" :loading="jobActionLoading" :disabled="!jobPrompt.trim() || !jobName.trim() || !currentServiceRunning" @click="createJob">创建轮次</el-button>
              </div>
            </div>
            <div class="instance-resume">
              <h3>恢复已有会话</h3>
              <p class="muted">继续该 Story 的历史会话，而不是新开一轮。</p>
              <div class="job-rename"><el-select v-model="selectedResumableSession" :loading="resumableLoading" placeholder="选择可恢复会话">
                <el-option v-for="session in resumableSessions" :key="session.sessionId" :label="session.name || session.sessionId" :value="session.sessionId" />
              </el-select><el-button :loading="jobActionLoading" :disabled="!selectedResumableSession || !currentServiceRunning" @click="resumeSession">恢复</el-button></div>
            </div>
          </template>
          <template v-else-if="selectedJob">
            <p class="eyebrow">SESSION OUTPUT</p>
            <div class="section-heading">
              <div>
                <h2>{{ selectedJob.name }}</h2>
                <p>
                  <span class="tag" :class="currentJobClass">{{ currentJobLabel }}</span>
                  {{ selectedJob.state }} · {{ selectedJob.id }} · {{ currentJobSession }}
                </p>
              </div>
              <div class="job-actions"><el-button size="small" :loading="jobActionLoading" @click="controlJob('stop')">暂停</el-button><el-button size="small" :loading="jobActionLoading" @click="controlJob('respawn')">重启</el-button><el-button size="small" type="danger" :loading="jobActionLoading" @click="controlJob('delete')">删除</el-button></div>
            </div>
            <div class="job-rename"><el-input v-model="renameDraft" size="small" placeholder="实例名称" /><el-button size="small" :loading="jobActionLoading" @click="renameJob">重命名</el-button></div>
            <JobDetailPanel
              :detail="jobDetail"
              :loading="jobDetailLoading"
              :error="jobDetailError"
              :pinned="selectedJobPinned"
              :pin-saving="jobPinSaving"
              @toggle-pin="toggleSelectedJobPin"
              @use-suggestion="useSuggestedReply"
            />
            <p v-if="jobPrefsError" class="mapping-error" role="alert">{{ jobPrefsError }}</p>
            <pre class="job-transcript">{{ jobTranscript || '暂无历史对话' }}</pre>
            <pre class="job-output">{{ jobOutput || '等待实时输出…' }}</pre>
            <div class="instance-reply">
              <el-input v-model="jobReply" type="textarea" :rows="3" placeholder="回复实例（不执行 bash）" />
              <div class="instance-upload">
                <el-upload
                  :auto-upload="false"
                  :show-file-list="false"
                  :on-change="onReplyFileChange"
                >
                  <el-button size="small" :loading="imageUploading">上传文件并插入回复</el-button>
                </el-upload>
                <span class="muted">文件写入 Story 项目的 .docs/&lt;storyId&gt;/ 目录</span>
              </div>
              <div class="instance-form-actions">
                <el-button type="primary" :loading="jobActionLoading" :disabled="!jobReply.trim()" @click="replyToJob">发送</el-button>
              </div>
            </div>
          </template>
          <template v-else-if="selectedEmptyGroupKey">
            <p class="eyebrow">NEW STORY</p>
            <h2>新建 Story 骨架</h2>
            <p class="muted">
              在「{{ storyTargetWorkspace.name }}」的第一个项目下创建最小 Story。创建后即可启动 CodeBuddy 实例，在对话中执行
              /start {{ storyDraft.storyId || '<storyId>' }} 由 Harness 补全需求。
            </p>
            <div class="instance-field story-tapd-binding">
              <span>已关联 TAPD 需求</span>
              <template v-if="storyTapdBinding.state === 'pending'">
                <span class="muted">正在查询工作区的 TAPD 关联…</span>
              </template>
              <template v-else-if="storyTapdBinding.state === 'bound'">
                <span class="tapd-bound-hint">已关联需求 #{{ storyTapdBinding.storyIdInTapd }}（{{ storyTapdBinding.title }}）</span>
              </template>
              <template v-else>
                <span class="muted">该工作区暂未关联 TAPD 需求，将创建不关联 TAPD 的骨架。</span>
              </template>
            </div>
            <div class="instance-form">
              <label class="instance-field">
                <span>Story ID</span>
                <el-input v-model="storyDraft.storyId" placeholder="如 customer-service-onboarding" />
              </label>
              <label class="instance-field">
                <span>Story 标题</span>
                <el-input v-model="storyDraft.title" placeholder="一句话描述这个 Story 要做什么" />
              </label>
            </div>
            <p v-if="storyCreateError" class="mapping-error" role="alert">{{ storyCreateError }}</p>
            <div class="instance-form-actions">
              <el-button @click="cancelStoryCreate()">取消</el-button>
              <el-button type="primary" :loading="storyCreating" :disabled="storyTapdBinding.state === 'pending'" @click="submitStoryCreate()">创建 Story</el-button>
            </div>
          </template>
          <template v-else>
            <p class="eyebrow">SESSION OUTPUT</p><h2>选择一个实例</h2><p class="muted">从左侧点选某个 Story 下的实例即可查看它的对话与实时输出；同一 Story 共用一台服务与端口，每轮 run/fixbugs 是独立 Job/session。</p><div class="terminal-placeholder">等待实例选择<span>_</span></div>
          </template>
          <p v-if="jobError" class="mapping-error" role="alert">{{ jobError }}</p>
        </section>
      </div>
</template>
