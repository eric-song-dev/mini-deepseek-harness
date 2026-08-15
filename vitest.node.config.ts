import { defineConfig } from 'vitest/config'

/** node workspace：host 侧（kernel/session/llm/agent/tools/web/test-support）+ apps 构建冒烟。 */
export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: [
      'packages/{kernel,session,llm,agent,tools,web,bundle-web,test-support}/tests/**/*.test.ts',
      'apps/web/tests/**/*.test.ts',
    ],
  },
})
