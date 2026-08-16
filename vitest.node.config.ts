import { defineConfig } from 'vitest/config'

/** node workspace：host 侧（kernel/session/llm/agent/tools/skill/web/test-support + M8 subagent/workflow + M9 mcp）+ apps 构建冒烟。 */
export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: [
      'packages/{kernel,session,llm,agent,tools,skill,web,bundle-web,test-support,subagent,workflow,mcp}/tests/**/*.test.ts',
      'apps/web/tests/**/*.test.ts',
    ],
  },
})
