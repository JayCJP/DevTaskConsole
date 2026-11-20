import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5432,
    // 显式监听 IPv4 回环地址，避免 localhost 解析到 ::1 导致浏览器连接被拒
    host: '127.0.0.1',
    // 允许被外部页面（如 CodeBuddy 工作台）以 iframe 嵌入：
    // 不发 X-Frame-Options，改用 CSP frame-ancestors 显式放开回环来源。
    headers: {
      'Content-Security-Policy': "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*;",
    },
    proxy: {
      '/api': 'http://127.0.0.1:7788',
    },
  },
})
