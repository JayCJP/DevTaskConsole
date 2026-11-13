import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { ElButton, ElDrawer, ElIcon, ElInput, ElTooltip } from 'element-plus'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-drawer.css'
import 'element-plus/theme-chalk/el-icon.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-tooltip.css'
import router from './router'
import './style.css'
import App from './App.vue'

createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElButton)
  .use(ElDrawer)
  .use(ElIcon)
  .use(ElInput)
  .use(ElTooltip)
  .mount('#app')
