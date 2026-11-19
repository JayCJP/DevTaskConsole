<script setup lang="ts">
/**
 * inbox 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  inbox,
  setInboxAnswer,
  jobs,
  storyAnswerCount,
  inboxReasonOf,
  store,
  inboxGroups,
  copyStoryAnswers,
  inboxExpandedId,
  toggleInboxAnswer,
  inboxAnswerMap,
  suggestionSegmentsOf,
  inboxAnswerText,
} = useConsoleContext()
</script>

<template>
      <div class="stat-grid">
        <article class="stat-card"><span>待决策</span><strong>{{ inbox.length }}</strong><small>{{ inbox.length ? '需要人工处理' : '当前无待决策项' }}</small></article>
        <article class="stat-card"><span>高优先级</span><strong>{{ inbox.filter((item) => item.priority === 'high').length }}</strong><small>{{ inbox.some((item) => item.priority === 'high') ? '先处理风险项' : '暂无风险项' }}</small></article>
        <article class="stat-card"><span>运行中实例</span><strong>{{ jobs.filter((job) => job.status === 'busy').length }}</strong><small>CodeBuddy jobs</small></article>
      </div>
      <section class="surface">
        <div class="section-heading">
          <div><h2>待你处理</h2><p>只显示阻塞流程或需要判断的事项；每个 Story 独立汇总答复</p></div>
          <span class="count-pill">{{ inbox.length }} 项</span>
        </div>
        <div v-if="inboxGroups.length" class="inbox-groups">
          <section v-for="group in inboxGroups" :key="group.key" class="inbox-workspace">
            <header class="inbox-workspace-head">
              <span class="inbox-workspace-name">
                <strong>{{ group.name }}</strong>
                <code v-if="group.pathHint">{{ group.pathHint }}</code>
                <span v-if="!group.synced" class="tag tag-warning">未同步到工作区</span>
              </span>
              <span class="count-pill">{{ group.itemCount }} 项 · 高优先级 {{ group.highCount }}</span>
            </header>
            <div v-for="story in group.stories" :key="story.key" class="inbox-story">
              <div class="inbox-story-head">
                <strong>{{ story.title }}</strong>
                <code>{{ story.storyId }}</code>
                <span v-if="story.highCount" class="tag tag-danger">高优先级 {{ story.highCount }}</span>
                <el-tooltip content="只复制本 Story 下已填答案，按 Q1:答案 格式，不回写上游" placement="bottom">
                  <span class="inbox-story-summary">
                    <el-button
                      type="primary"
                      plain
                      size="small"
                      :disabled="!storyAnswerCount(story.items)"
                      @click="copyStoryAnswers(story.items)"
                    >汇总答复<span v-if="storyAnswerCount(story.items)" class="count-pill count-pill-inline">{{ storyAnswerCount(story.items) }}</span></el-button>
                  </span>
                </el-tooltip>
              </div>
              <div class="inbox-list">
                <template v-for="item in story.items" :key="item.id">
                  <article class="inbox-row" :class="{ 'inbox-row-expanded': inboxExpandedId === item.id }">
                    <span class="priority-marker" :class="item.priority">{{ item.priority === 'high' ? '!' : '·' }}</span>
                    <div class="inbox-copy"><div class="inbox-title-line"><strong>{{ item.title }}</strong><span class="kind-label">{{ item.kind.replaceAll('_', ' ') }}</span></div><p v-if="inboxReasonOf(item)">{{ inboxReasonOf(item) }}</p></div>
                    <div class="inbox-row-actions">
                      <el-button
                        link
                        type="primary"
                        size="small"
                        :aria-expanded="inboxExpandedId === item.id"
                        @click="toggleInboxAnswer(item.id)"
                      >答复<span v-if="inboxAnswerMap[item.id]?.text.trim()" class="answer-dot" :aria-label="`已填写 ${inboxAnswerMap[item.id].text.trim().length} 字`" /></el-button>
                      <el-button type="primary" plain size="small" :disabled="!item.target" @click="item.target && $router.push(item.target)">查看处理</el-button>
                    </div>
                  </article>
                  <div v-if="inboxExpandedId === item.id" class="inbox-answer">
                    <div v-if="suggestionSegmentsOf(item).length" class="inbox-answer-suggestion">
                      <div class="inbox-answer-suggestion-head">建议稿</div>
                      <div class="inbox-answer-suggestion-body">
                        <div v-for="(segment, index) in suggestionSegmentsOf(item)" :key="index" class="suggestion-row">
                          <span v-if="segment.marker" class="suggestion-marker">{{ segment.marker }}</span>
                          <span class="suggestion-text">{{ segment.text }}</span>
                        </div>
                      </div>
                    </div>
                    <el-input
                      :model-value="inboxAnswerText(item.id)"
                      type="textarea"
                      :rows="3"
                      resize="none"
                      placeholder="写下你的答复…"
                      :aria-label="`为「${item.title}」填写答复`"
                      @update:model-value="setInboxAnswer(item.id, $event)"
                    />
                    <div class="inbox-answer-foot"><span class="inbox-answer-note">仅本地记录，用于汇总复制，不会回写上游</span><el-button link size="small" @click="toggleInboxAnswer(item.id)">收起</el-button></div>
                  </div>
                </template>
              </div>
            </div>
          </section>
        </div>
        <div v-else-if="!store.loaded" class="empty-compact">正在加载快照…</div>
        <div v-else class="empty-state"><span class="empty-icon">✓</span><strong>{{ store.error ? '连接数据源后显示待决策事项' : '现在没有需要你决策的事' }}</strong><p>{{ store.error ? '请先完成连接自检，或检查后端数据聚合器。' : '新出现的阻塞项、待确认项和失败构建会集中显示在这里。' }}</p></div>
      </section>
</template>
