<script setup lang="ts">
/**
 * tools 页面视图。
 * 从 ConsolePage.vue 拆分而来，共享状态由 ConsoleShell 通过 provide 下发。
 * 展示数据源通道状态，并承载控制台可编辑配置（源仓库根目录 / TAPD 处理人 / 缓存目录）。
 */
import { computed, ref, watch } from 'vue'
import { useConsoleContext } from '../composables/useConsoleContext'

const {
  codebuddyChannelView,
  describeChannelError,
  snapshotLoading,
  refreshSnapshot,
  channelRows,
  channelUnavailable,
  settings,
  settingsSaving,
  settingsError,
  saveSettings,
  actionToasts,
} = useConsoleContext()

/** 源仓库根目录草稿 */
const sourceRootDraft = ref('')
/** TAPD 默认处理人草稿 */
const tapdOwnerDraft = ref('')
/** 缓存数据目录草稿 */
const cacheDirectoryDraft = ref('')

// 后端配置加载完成后同步到表单草稿；保存成功后 settings 更新也会同步回来
watch(
  settings,
  (value) => {
    sourceRootDraft.value = value.devtaskSourceRoot ?? ''
    tapdOwnerDraft.value = value.tapdOwner ?? ''
    cacheDirectoryDraft.value = value.cacheDirectory ?? ''
  },
  { immediate: true },
)

/** 是否有未保存的修改 */
const settingsDirty = computed(
  () =>
    sourceRootDraft.value.trim() !== (settings.value.devtaskSourceRoot ?? '') ||
    tapdOwnerDraft.value.trim() !== (settings.value.tapdOwner ?? '') ||
    cacheDirectoryDraft.value.trim() !== (settings.value.cacheDirectory ?? ''),
)

/**
 * 保存配置草稿到后端。
 * 保存后的业务联动（刷新候选 / 看板、缓存目录重启提示）由 saveSettings 统一处理。
 * @returns Promise<void>
 */
async function onSaveSettings(): Promise<void> {
  // 保存前判断是否改动缓存目录：该配置需重启服务，合并进一条提示，避免双重 toast
  const cacheDirectoryChanged =
    cacheDirectoryDraft.value.trim() !== (settings.value.cacheDirectory ?? '')
  try {
    const ok = await saveSettings({
      devtaskSourceRoot: sourceRootDraft.value.trim(),
      tapdOwner: tapdOwnerDraft.value.trim(),
      cacheDirectory: cacheDirectoryDraft.value.trim(),
    })
    if (ok) {
      actionToasts.notify(
        cacheDirectoryChanged ? '配置已保存，缓存目录需重启服务后生效。' : '配置已保存。',
        'success',
      )
    } else {
      actionToasts.notify('配置保存失败。', 'error')
    }
  } catch (error) {
    actionToasts.notify(
      `配置保存失败：${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
  }
}
</script>

<template>
  <div class="tool-grid">
    <section class="surface">
      <div class="section-heading">
        <div>
          <h2>通道状态</h2>
          <p>读取统一快照中的数据源健康状态</p>
        </div>
        <el-button :loading="snapshotLoading" @click="refreshSnapshot(true)">重新检测</el-button>
      </div>
      <div
        v-for="row in channelRows"
        :key="row.key"
        class="channel-row"
        :title="row.channel?.error || ''"
      >
        <span
          class="status-dot"
          :class="!row.channel ? '' : row.channel.ok ? 'is-active' : 'is-error'"
        />
        <strong>{{ row.label }}</strong>
        <span>
          <template v-if="!row.channel">未检测 · 快照中暂无该通道结果</template>
          <template v-else-if="row.key === 'codebuddy'">
            <template v-if="row.channel.ok"
              >已安装 · {{ codebuddyChannelView(row.channel.error || '').text }}</template
            >
            <template v-else>
              <div>{{ codebuddyChannelView(row.channel.error || '').text }}</div>
              <a
                v-if="codebuddyChannelView(row.channel.error || '').installUrl"
                :href="codebuddyChannelView(row.channel.error || '').installUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="channel-install-link"
                >前往安装</a
              >
            </template>
          </template>
          <template v-else-if="row.channel.ok"
            >连接正常<small class="channel-purpose">{{ row.purpose }}</small></template
          >
          <template v-else>
            <div>
              不可用 —— {{ describeChannelError(row.channel.error || '').reason }}。{{
                describeChannelError(row.channel.error || '').action
              }}。
            </div>
            <small v-if="row.channel.error" class="channel-error-raw"
              >原始信息：{{ row.channel.error }}</small
            >
          </template>
        </span>
        <small
          >{{
            row.channel?.fetchedAt ? new Date(row.channel.fetchedAt).toLocaleString() : '尚未检测'
          }}{{ row.channel?.stale ? ' · 缓存' : '' }}</small
        >
      </div>
      <p v-if="channelUnavailable" class="mapping-footnote">
        以上任一通道不可用都会影响对应页面的数据；控制台不会用旧数据冒充新数据。
      </p>
    </section>

    <section class="surface">
      <div class="section-heading">
        <div>
          <h2>控制台配置</h2>
          <p>配置保存在本地；源仓库根目录与处理人保存后立即生效</p>
        </div>
        <el-button
          type="primary"
          :loading="settingsSaving"
          :disabled="!settingsDirty"
          @click="onSaveSettings"
          >保存配置</el-button
        >
      </div>
      <div class="settings-fields">
        <label class="settings-field">
          <span>源仓库根目录</span>
          <el-input
            v-model="sourceRootDraft"
            placeholder="例如 D:\workfile；留空则回退环境变量或默认目录"
          />
          <small
            >工作区候选项目的扫描根目录，其下每个含 .git
            的子目录会作为可选项目。修改后候选列表会自动刷新。</small
          >
        </label>
        <label class="settings-field">
          <span>TAPD 默认处理人</span>
          <el-input v-model="tapdOwnerDraft" placeholder="例如 蔡杰鹏；留空则回退默认值" />
          <small>看板默认查询的处理人，以及 Bug 修复任务口径中的处理人。看板页仍可手动切换。</small>
        </label>
        <label class="settings-field">
          <span>缓存数据目录</span>
          <el-input v-model="cacheDirectoryDraft" placeholder="留空则使用默认数据目录" />
          <small
            >候选项目 / 看板 /
            快照缓存文件的存放目录。此配置需重启后端服务后生效；留空则回退默认数据目录。</small
          >
        </label>
      </div>
      <p v-if="settingsError" class="mapping-footnote">配置读取失败：{{ settingsError }}</p>
    </section>

    <section class="surface">
      <h2>本机信任边界</h2>
      <p class="muted">
        控制台 API 由本地访问令牌保护。CodeBuddy 服务使用
        <code>--auth none</code> 时，本机其他进程仍可能访问其高权限 API；Loopback
        和请求标记不构成上游认证。
      </p>
    </section>
  </div>
</template>
