import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 单根配置跑全部包；M4 上 Web（jsdom）测试时再拆 workspace
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
  },
})
