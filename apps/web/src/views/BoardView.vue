<script setup lang="ts">
/**
 * board 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'

const ctx = useConsoleContext()
const board = ctx.board as any
const { boardStatusTag, boardErrorHint } = ctx
</script>

<template>
  <section class="surface">
    <div class="section-heading">
      <div>
        <h2>需求总览</h2>
        <p>数据元以 TAPD 需求为准；每个需求可关联一个本地工作区</p>
      </div>
      <div class="board-controls">
        <el-input
          v-model="board.owner"
          class="board-owner-input"
          placeholder="TAPD 处理人"
          clearable
          @keyup.enter="board.load()"
          aria-label="按 TAPD 处理人筛选"
        />
        <el-select
          :model-value="board.includeReleased"
          class="board-filter"
          placeholder="状态筛选"
          @change="board.setIncludeReleased"
        >
          <el-option label="排除已发布（默认）" :value="false" />
          <el-option label="包含已发布" :value="true" />
        </el-select>
        <el-button :loading="board.loading" @click="board.load(true)">刷新</el-button>
        <el-button type="primary" @click="board.openManual()">手动添加</el-button>
      </div>
    </div>
    <div class="board-meta">
      <span v-if="board.fetchedAt"
        >TAPD 拉取于 {{ new Date(board.fetchedAt).toLocaleString() }}</span
      >
      <span>{{ board.stories.length }} 个需求</span>
      <span v-if="!board.includeReleased && board.hiddenReleased" class="board-meta-hidden">
        已隐藏 {{ board.hiddenReleased }} 条已发布
        <el-button link type="primary" size="small" @click="board.setIncludeReleased(true)"
          >查看</el-button
        >
      </span>
      <span class="board-meta-status">
        <span class="tag" :class="boardStatusTag.tone">{{ boardStatusTag.label }}</span>
      </span>
    </div>
    <div v-if="board.error" class="notice notice-danger" role="alert">
      <span class="notice-symbol">!</span>
      <div>
        <strong>TAPD 需求查询失败</strong>
        <p>
          {{ boardErrorHint.reason }}。{{
            boardErrorHint.action
          }}。<br />下方仅显示本地已绑定、尚未同步到 TAPD 的需求。<br /><small
            class="board-error-detail"
            >{{ board.error }}</small
          >
        </p>
      </div>
      <el-button text @click="board.load(true)">重试</el-button>
    </div>
    <div v-if="board.stories.length" class="board-list">
      <article
        v-for="story in board.stories"
        :key="story.storyId"
        class="board-parent"
        :class="{ 'is-expanded': board.isParentExpanded(story.storyId) }"
      >
        <div class="board-row board-parent-row">
          <div class="board-main">
            <button
              type="button"
              class="board-expand-button"
              :aria-expanded="board.isParentExpanded(story.storyId)"
              :aria-label="board.isParentExpanded(story.storyId) ? '收起子需求' : '展开子需求'"
              @click="board.toggleParent(story.storyId)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <a :href="story.parentTapdUrl ?? story.tapdUrl" target="_blank" rel="noreferrer">{{
              story.title
            }}</a>
            <small>
              <code>{{ story.storyId }}</code>
              <span v-if="story.statusLabel || story.status" :title="story.status"
                >状态 {{ story.statusLabel ?? story.status }}</span
              >
              <span v-if="story.iterationName">{{ story.iterationName }}</span>
              <span v-if="story.owner">{{ story.owner }}</span>
              <span v-if="board.childrenOf(story).length" class="board-child-count"
                >{{ board.childrenOf(story).length }} 个子需求</span
              >
              <span v-if="story.bugNew || story.bugReopened" class="board-bug-count"
                >本人缺陷 {{ (story.bugNew ?? 0) + (story.bugReopened ?? 0) }}</span
              >
            </small>
          </div>
          <div class="board-workspace">
            <el-select
              v-model="board.workspaceDraft[story.storyId]"
              clearable
              filterable
              placeholder="选择本地工作区"
              @change="board.bindSelected(story)"
            >
              <el-option
                v-for="workspace in board.workspaceOptionsFor(story)"
                :key="workspace.name"
                :label="workspace.name"
                :value="workspace.name"
              />
            </el-select>
            <code v-if="story.workspacePath">{{ story.workspacePath }}</code>
            <small v-else-if="story.workspaceName" class="mapping-error"
              >目录未找到：{{ story.workspaceName }}</small
            >
            <small v-if="!story.inTapdList" class="tag tag-warning">本地手动添加</small>
          </div>
          <div class="board-actions">
            <el-button
              size="small"
              :loading="board.unbindingStoryId === story.storyId"
              :disabled="!story.workspaceName"
              @click="board.unbindWorkspace(story.storyId)"
              >解绑</el-button
            >
          </div>
          <p v-if="board.rowErrors[story.storyId]" class="mapping-error" role="alert">
            {{ board.rowErrors[story.storyId] }}
          </p>
        </div>
        <div v-show="board.isParentExpanded(story.storyId)" class="board-children">
          <div
            v-for="child in board.childrenOf(story)"
            :key="child.storyId"
            class="board-row board-child-row"
          >
            <div class="board-main">
              <a :href="child.parentTapdUrl ?? child.tapdUrl" target="_blank" rel="noreferrer">{{
                child.title
              }}</a>
              <small>
                <code>{{ child.storyId }}</code>
                <span v-if="child.statusLabel || child.status" :title="child.status"
                  >状态 {{ child.statusLabel ?? child.status }}</span
                >
                <span v-if="child.owner">{{ child.owner }}</span>
              </small>
            </div>
            <div class="board-workspace">
              <small class="muted">工作区绑定在父需求上</small>
            </div>
          </div>
          <div v-if="!board.childrenOf(story).length" class="board-children-empty">
            该父需求下没有未发布的子需求。
          </div>
        </div>
      </article>
    </div>
    <div v-else-if="board.loading" class="empty-compact">正在查询 TAPD 需求…</div>
    <div v-else-if="board.error" class="notice notice-danger" role="alert">
      <span class="notice-symbol">!</span>
      <div>
        <strong>TAPD 需求查询失败</strong>
        <p>
          {{ boardErrorHint.reason }}。{{ boardErrorHint.action }}。<br /><small
            class="board-error-detail"
            >{{ board.error }}</small
          >
        </p>
      </div>
      <el-tooltip content="重新查询 TAPD；可能消耗查询配额" placement="left">
        <span><el-button text @click="board.load(true)">重试</el-button></span>
      </el-tooltip>
    </div>
    <div v-else class="empty-state">
      <strong>当前处理人「{{ board.owner }}」名下没有未发布需求</strong>
      <p>可检查姓名是否为 TAPD 中的写法，或用「手动添加」直接绑定需求链接。</p>
    </div>
  </section>

  <el-dialog
    v-model="board.manualOpen"
    title="手动添加需求"
    width="min(560px, 94vw)"
    :close-on-click-modal="false"
    @close="board.closeManual()"
  >
    <div class="board-manual-form">
      <label
        >TAPD 需求链接或 ID<el-input
          v-model="board.manualDraft.tapdStoryId"
          placeholder="https://www.tapd.cn/.../view/1138... 或纯数字 ID；子需求链接会自动绑定到其父需求"
      /></label>
      <label
        >需求名称（可选，TAPD 查询不到时展示）<el-input v-model="board.manualDraft.storyTitle"
      /></label>
      <label
        >关联本地工作区<el-select
          v-model="board.manualDraft.workspaceName"
          filterable
          placeholder="选择 *.code-workspace 识别出的工作区"
        >
          <el-option
            v-for="workspace in board.workspaces"
            :key="workspace.name"
            :label="workspace.name"
            :value="workspace.name"
          /> </el-select
      ></label>
    </div>
    <p v-if="board.manualError" class="mapping-error" role="alert">{{ board.manualError }}</p>
    <template #footer>
      <el-button @click="board.closeManual()">取消</el-button>
      <el-button type="primary" :loading="board.manualSaving" @click="board.submitManual()"
        >保存绑定</el-button
      >
    </template>
  </el-dialog>
</template>
