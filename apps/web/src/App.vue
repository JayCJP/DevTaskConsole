<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  FolderOpened,
  Grid,
  MessageBox,
  Monitor,
  Moon,
  Promotion,
  Search,
  Setting,
  Share,
  Sunny,
  Timer,
} from '@element-plus/icons-vue'
import { ApiError, apiRequest, clearConsoleToken, readConsoleToken, saveConsoleToken } from './api/client'
import { navItems } from './router'
import { useConsoleStore } from './stores/console'

const router = useRouter()
const route = useRoute()
const store = useConsoleStore()
const icons = { inbox: MessageBox, board: Grid, pipeline: Share, instances: Monitor, crons: Timer, releases: Promotion, workspaces: FolderOpened }
const token = ref('')
const authenticated = ref(false)
const loginError = ref('')
const commandOpen = ref(false)
const commandQuery = ref('')
const commandInput = ref<HTMLInputElement | null>(null)
const darkMode = ref(localStorage.getItem('devtask-theme') !== 'light')
const pendingG = ref(false)
let pendingGTimeout: ReturnType<typeof setTimeout> | undefined

const commandItems = computed(() => {
  const query = commandQuery.value.trim().toLocaleLowerCase()
  return navItems.filter((item) => !query || item.title.toLocaleLowerCase().includes(query) || item.path.includes(query))
})
const pageTitle = computed(() => String(route.meta.title ?? 'DevTask Console'))
const connectionWarning = computed(() =>
  Boolean(store.error) || Boolean(store.snapshot && Object.values(store.snapshot.channels).some((channel) => !channel.ok)),
)
const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

/**
 * 使用本机令牌登录控制台。
 * 成功后把令牌持久化到 localStorage，并立即拉取首屏快照。
 * @returns Promise<void>，失败时把错误写入 loginError
 */
async function login(): Promise<void> {
  loginError.value = ''
  try {
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token: token.value }),
    })
    saveConsoleToken(token.value.trim())
    authenticated.value = true
    await store.refresh()
  } catch (cause) {
    loginError.value = cause instanceof Error ? cause.message : 'Authentication failed.'
  }
}

/**
 * 刷新页面后恢复登录态。
 * 只要本地存有令牌就进入控制台并主动拉取快照，
 * 避免刷新后页面停留在“没有数据”的空状态。
 * @returns Promise<void>
 */
async function validateSession(): Promise<void> {
  const savedToken = readConsoleToken()
  if (!savedToken) return
  authenticated.value = true
  try {
    await apiRequest('/api/v1/health')
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      clearConsoleToken()
      authenticated.value = false
      return
    }
    store.error = cause instanceof Error ? cause.message : 'The console API is unavailable.'
  }
  // 无论健康检查结果如何都尝试拉取一次快照，保证刷新后有数据（或明确的错误提示）
  await store.refresh()
}

function openCommand(): void {
  commandOpen.value = true
  commandQuery.value = ''
  void nextTick(() => commandInput.value?.focus())
}

function navigateTo(path: string): void {
  commandOpen.value = false
  void router.push(path)
}

/**
 * 把当前主题同时写入 data-theme 与 .dark 类。
 * data-theme 驱动本项目的语义令牌，.dark 类驱动 Element Plus 内置的暗色变量，
 * 两者同时存在才能保证弹窗、下拉等 EP 组件与页面主题一致。
 * @param dark 是否为暗色主题
 */
function applyTheme(dark: boolean): void {
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.classList.toggle('dark', dark)
}

function toggleTheme(): void {
  darkMode.value = !darkMode.value
  localStorage.setItem('devtask-theme', darkMode.value ? 'dark' : 'light')
  applyTheme(darkMode.value)
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target
  const editing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openCommand()
    return
  }
  if (event.key === 'Escape' && commandOpen.value) {
    commandOpen.value = false
    return
  }
  if (editing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === '/') {
    event.preventDefault()
    openCommand()
    return
  }
  if (pendingG.value) {
    const item = navItems.find((navItem) => navItem.shortcut.endsWith(event.key.toLowerCase()))
    pendingG.value = false
    if (pendingGTimeout) clearTimeout(pendingGTimeout)
    if (item) navigateTo(item.path)
    return
  }
  if (event.key.toLowerCase() === 'g') {
    pendingG.value = true
    pendingGTimeout = setTimeout(() => {
      pendingG.value = false
    }, 800)
  } else if (event.key.toLowerCase() === 't') {
    toggleTheme()
  }
}

// 不做快照定时自动刷新：每次刷新都会触发后端聚合 TAPD/GitLab/DevOps，
// 既消耗上游接口配额（TAPD 易触发 429），也会把用户正在看的状态刷掉。
// 数据只在登录、进入页面、手动点「刷新/重新检测/重试」以及写操作完成后更新。

onMounted(() => {
  applyTheme(darkMode.value)
  window.addEventListener('keydown', onKeydown)
  void validateSession()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (pendingGTimeout) clearTimeout(pendingGTimeout)
})
</script>

<template>
  <div v-if="!authenticated" class="login-screen">
    <form class="login-card" @submit.prevent="login">
      <div class="brand-mark">DT</div>
      <div>
        <h1>DevTask Console</h1>
        <p class="muted">输入本机控制台访问令牌以继续。</p>
      </div>
      <el-input v-model="token" type="password" show-password autocomplete="current-password" placeholder="本机访问令牌" />
      <p v-if="loginError" class="error-text">{{ loginError }}</p>
      <el-button type="primary" native-type="submit" :disabled="!token.trim()" class="login-button">解锁控制台</el-button>
      <p class="login-help">令牌保存在本机用户数据目录的 <code>control-panel-token</code> 文件中。</p>
    </form>
  </div>

  <div v-else class="app-shell" :class="{ 'light-theme': !darkMode }">
    <aside class="nav-rail">
      <button class="brand-lockup" type="button" aria-label="DevTask Console 首页" @click="navigateTo('/inbox')">
        <span class="brand-mark">DT</span>
      </button>
      <nav class="primary-nav" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-link" :title="`${item.title} · ${item.shortcut}`">
          <el-icon><component :is="icons[item.icon]" /></el-icon>
          <span>{{ item.title }}</span>
          <span v-if="route.path === item.path" class="nav-active-mark" />
        </RouterLink>
      </nav>
      <div class="rail-bottom">
        <el-tooltip content="连接与配置" placement="right">
          <RouterLink to="/tools" class="tool-link" :class="{ active: route.path === '/tools' }" aria-label="连接与配置">
            <el-icon><Setting /></el-icon>
          </RouterLink>
        </el-tooltip>
        <span class="version-mark">LOCAL</span>
      </div>
    </aside>

    <div class="workspace-shell">
      <header class="topbar">
        <div class="breadcrumb"><span>DevTask</span><span class="breadcrumb-separator">/</span><strong>{{ pageTitle }}</strong></div>
        <div class="topbar-actions">
          <button class="search-trigger" type="button" @click="openCommand">
            <el-icon><Search /></el-icon><span>搜索或执行命令</span><kbd>{{ shortcutLabel }}</kbd>
          </button>
          <button class="icon-button" type="button" :aria-label="darkMode ? '切换亮色主题' : '切换暗色主题'" @click="toggleTheme">
            <el-icon><component :is="darkMode ? Sunny : Moon" /></el-icon>
          </button>
          <RouterLink to="/tools" class="connection-chip" :class="connectionWarning ? 'connection-warning' : 'connection-unknown'">
            <span class="status-dot" :class="connectionWarning ? 'is-error' : ''" />{{ connectionWarning ? '需检查连接' : '连接正常' }}
          </RouterLink>
        </div>
      </header>

      <main class="page-scroll">
        <RouterView />
      </main>
    </div>

    <div v-if="commandOpen" class="command-overlay" @click.self="commandOpen = false">
      <section class="command-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="command-input-row">
          <el-icon><Search /></el-icon>
          <input ref="commandInput" v-model="commandQuery" placeholder="跳转页面…" @keydown.down.prevent="commandInput?.blur()" @keydown.enter="commandItems[0] && navigateTo(commandItems[0].path)" />
          <kbd>ESC</kbd>
        </div>
        <p class="command-caption">导航</p>
        <button v-for="item in commandItems" :key="item.path" class="command-result" type="button" @click="navigateTo(item.path)">
          <el-icon><component :is="icons[item.icon]" /></el-icon>
          <span>{{ item.title }}</span>
          <kbd>{{ item.shortcut }}</kbd>
        </button>
        <button v-if="commandItems.length === 0" class="command-empty" type="button" disabled>没有匹配页面</button>
      </section>
    </div>
  </div>
</template>
