import { createRouter, createWebHistory } from 'vue-router'
import ConsolePage from '../views/ConsolePage.vue'

export const navItems = [
  { path: '/inbox', title: '收件箱', shortcut: 'g i', icon: 'inbox' },
  { path: '/board', title: '看板', shortcut: 'g d', icon: 'board' },
  { path: '/pipeline', title: '流水线', shortcut: 'g p', icon: 'pipeline' },
  { path: '/instances', title: '实例', shortcut: 'g c', icon: 'instances' },
  { path: '/crons', title: '定时', shortcut: 'g t', icon: 'crons' },
  { path: '/releases', title: '发布', shortcut: 'g r', icon: 'releases' },
  { path: '/workspaces', title: '工作区', shortcut: 'g w', icon: 'workspaces' },
] as const

const routes = [
  { path: '/', redirect: '/inbox' },
  ...navItems.map((item) => ({
    path: item.path,
    component: ConsolePage,
    meta: { title: item.title, page: item.icon },
  })),
  { path: '/tools', component: ConsolePage, meta: { title: '连接与配置', page: 'tools' } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
