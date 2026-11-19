import { createRouter, createWebHistory } from 'vue-router'
import ConsoleShell from '../views/ConsoleShell.vue'

export const navItems = [
  { path: '/inbox', title: '收件箱', shortcut: 'g i', icon: 'inbox' },
  { path: '/board', title: '看板', shortcut: 'g d', icon: 'board' },
  { path: '/pipeline', title: '流水线', shortcut: 'g p', icon: 'pipeline' },
  { path: '/instances', title: '实例', shortcut: 'g c', icon: 'instances' },
  { path: '/crons', title: '定时', shortcut: 'g t', icon: 'crons' },
  { path: '/releases', title: '发布', shortcut: 'g r', icon: 'releases' },
  { path: '/workspaces', title: '工作区', shortcut: 'g w', icon: 'workspaces' },
] as const

/** 各页面视图的懒加载映射，按 navItems.icon 取值 */
const views: Record<string, () => Promise<unknown>> = {
  inbox: () => import('../views/InboxView.vue'),
  board: () => import('../views/BoardView.vue'),
  pipeline: () => import('../views/PipelineView.vue'),
  instances: () => import('../views/InstancesView.vue'),
  crons: () => import('../views/CronsView.vue'),
  releases: () => import('../views/ReleasesView.vue'),
  workspaces: () => import('../views/WorkspacesView.vue'),
  tools: () => import('../views/ToolsView.vue'),
}

const routes = [
  { path: '/', redirect: '/inbox' },
  {
    path: '/',
    component: ConsoleShell,
    children: [
      ...navItems.map((item) => ({
        path: item.path.slice(1),
        component: views[item.icon],
        meta: { title: item.title, page: item.icon },
      })),
      { path: 'tools', component: views.tools, meta: { title: '连接与配置', page: 'tools' } },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
