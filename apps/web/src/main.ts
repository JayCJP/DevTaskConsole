import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
// 使用 Element Plus 完整样式：抽屉/弹窗依赖 el-overlay 等基础样式，
// 之前按需引入缺少 el-overlay.css，导致 el-drawer 遮罩层级与点击区域失效。
import 'element-plus/dist/index.css'
import router from './router'
import './style.css'
import App from './App.vue'

/**
 * 创建并挂载 Vue 应用。
 * 说明：console 属于本地工具型应用，统一注册 Element Plus 全量组件，
 * 避免逐个组件注册时漏注册（如 el-select / el-checkbox）导致页面元素不渲染。
 */
createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElementPlus, { locale: zhCn })
  .mount('#app')
