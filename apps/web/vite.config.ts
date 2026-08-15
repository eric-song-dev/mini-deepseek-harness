import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// apps/web 只是客户端壳：Vite 把它打包成静态产物，由 packages/web 的 host 服务。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
