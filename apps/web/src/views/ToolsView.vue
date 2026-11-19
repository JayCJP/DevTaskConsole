<script setup lang="ts">
/**
 * tools 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 */
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  codebuddyChannelView,
  describeChannelError,
  snapshotLoading,
  refreshSnapshot,
  channelRows,
  channelUnavailable,
} = useConsoleContext()
</script>

<template>
      <div class="tool-grid">
        <section class="surface"><div class="section-heading"><div><h2>通道状态</h2><p>读取统一快照中的数据源健康状态</p></div><el-button :loading="snapshotLoading" @click="refreshSnapshot(true)">重新检测</el-button></div>
          <div v-for="row in channelRows" :key="row.key" class="channel-row" :title="row.channel?.error || ''">
            <span class="status-dot" :class="!row.channel ? '' : row.channel.ok ? 'is-active' : 'is-error'" />
            <strong>{{ row.label }}</strong>
            <span>
              <template v-if="!row.channel">未检测 · 快照中暂无该通道结果</template>
              <template v-else-if="row.key === 'codebuddy'">
                <template v-if="row.channel.ok">已安装 · {{ codebuddyChannelView(row.channel.error || '').text }}</template>
                <template v-else>
                  <div>{{ codebuddyChannelView(row.channel.error || '').text }}</div>
                  <a v-if="codebuddyChannelView(row.channel.error || '').installUrl"
                     :href="codebuddyChannelView(row.channel.error || '').installUrl"
                     target="_blank" rel="noopener noreferrer" class="channel-install-link">前往安装</a>
                </template>
              </template>
              <template v-else-if="row.channel.ok">连接正常<small class="channel-purpose">{{ row.purpose }}</small></template>
              <template v-else>
                <div>不可用 —— {{ describeChannelError(row.channel.error || '').reason }}。{{ describeChannelError(row.channel.error || '').action }}。</div>
                <small v-if="row.channel.error" class="channel-error-raw">原始信息：{{ row.channel.error }}</small>
              </template>
            </span>
            <small>{{ row.channel?.fetchedAt ? new Date(row.channel.fetchedAt).toLocaleString() : '尚未检测' }}{{ row.channel?.stale ? ' · 缓存' : '' }}</small>
          </div>
          <p v-if="channelUnavailable" class="mapping-footnote">以上任一通道不可用都会影响对应页面的数据；控制台不会用旧数据冒充新数据。</p>
        </section>
        <section class="surface"><p class="eyebrow">LOCAL SECURITY</p><h2>本机信任边界</h2><p class="muted">控制台 API 由本地访问令牌保护。CodeBuddy 服务使用 <code>--auth none</code> 时，本机其他进程仍可能访问其高权限 API；Loopback 和请求标记不构成上游认证。</p></section>
      </div>
</template>
