import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { SubagentRuntime } from '@mini-dsh/subagent'
import type { SubagentProvider, SubagentRun } from '@mini-dsh/subagent'
import { WorkflowEngine } from '@mini-dsh/workflow'

/**
 * 【M8 教程练习 2：写一段 workflow 脚本并体会 fatal 纪律】（零 key）
 *
 * 你要做的事：不写实现，只补两个断言——
 *   1. parallel 脚本的返回值（哪些是结果、哪个是逐项 null）？
 *   2. 拼错 agent() 选项时，脚本的结果是 error 而不是静默成功（agentsStarted 是多少）？
 *
 * 红绿翻转（小白验收）：把第 57 行的期望值 2 改成 3，运行测试看红
 * （fatal 错误在启动子 agent 之前就终止了脚本，计数不可能到 3），再改回来变绿。
 *
 * 运行：pnpm vitest run packages/workflow/tests/my-workflow.test.ts
 * 教程：docs/tutorials/M8-subagent-workflow.md
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-my-workflow-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 假提供方：每次 start 都返回一个立刻完成的子 run。 */
function makeProvider(): SubagentProvider {
  let count = 0
  return {
    name: 'fake',
    inheritsParentContext: false,
    async start() {
      count++
      const run: SubagentRun = {
        id: `child-${count}`,
        result: Promise.resolve({ output: `子任务 ${count} 的回答`, stopReason: 'completed' }),
        dispose: async () => {},
      }
      return run
    },
  }
}

describe('我的第一段 workflow 脚本（M8 教程练习）', () => {
  it('parallel 三件套：结果 / 逐项 null / 计数', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(jsonlPersistence, { dir })
    await ctx.plugin(SessionManager)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(WorkflowEngine, { provider: 'fake' })
    ctx.subagents.registerProvider(makeProvider())

    const parent = await ctx.get('session-manager')!.create({ title: '练习父会话' })
    const run = ctx.workflowEngine.start({
      meta: { name: 'my-first', description: '我的第一段脚本' },
      script: `
        return parallel([
          async () => agent('任务一'),
          async () => { throw new Error('普通脚本错') },
          async () => agent('任务二'),
        ])
      `,
      parent: parent.ctx,
    })
    const result = await run.result
    await run.dispose()

    // —— 练习 1：脚本返回值是什么？（普通错误 → 逐项 null，子 agent 结果原样回收）——
    expect(result.value).toEqual(['子任务 1 的回答', null, '子任务 2 的回答'])
    expect(result.stopReason).toBe('completed')

    // 顺手看一眼：观察事件按 seq 配对、不落父日志
    expect(parent.log).toHaveLength(1)
    await dispose()
  })

  it('拼错选项是 fatal：脚本以 error 终止，绝不静默成功', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(jsonlPersistence, { dir })
    await ctx.plugin(SessionManager)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(WorkflowEngine, { provider: 'fake' })
    ctx.subagents.registerProvider(makeProvider())

    const parent = await ctx.get('session-manager')!.create({ title: '练习父会话' })
    const run = ctx.workflowEngine.start({
      meta: { name: 'my-bad', description: '拼错选项' },
      script: 'return parallel([async () => agent("任务", { typo: true }), async () => agent("任务二")])',
      parent: parent.ctx,
    })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/UNSUPPORTED_OPTION/)
    // —— 练习 2：agentsStarted 是多少？（拼错的调用在计数之前就被拒；但并行里
    //    已被接受的另一个 agent 调用仍被计数 → 1。红绿翻转点在这一行：把 1 改成
    //    0 或 2 看红，再改回来变绿。）——
    expect(result.agentsStarted).toBe(1)
    await dispose()
  })
})
