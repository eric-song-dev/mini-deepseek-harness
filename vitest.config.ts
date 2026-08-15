import { defineConfig } from 'vitest/config'

// M4 起拆 workspace：node 侧（host/agent/session 等）与 jsdom 侧（client 组件）分开跑，
// 互不污染环境（M4 spec 决策 7）。两个 project 的 include 互不重叠。
export default defineConfig({
  test: {
    projects: ['vitest.node.config.ts', 'vitest.dom.config.ts'],
  },
})
