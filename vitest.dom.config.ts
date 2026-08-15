import { defineConfig } from 'vitest/config'

/** jsdom workspace：client 组件与 UI 装配（零网络：内存桥 + jsdom 渲染）。 */
export default defineConfig({
  test: {
    name: 'dom',
    environment: 'jsdom',
    include: ['packages/client/tests/**/*.test.{ts,tsx}'],
  },
})
