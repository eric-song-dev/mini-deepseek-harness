import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { createToolRegistry, provideTools } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'

/**
 * M3 教程练习（docs/tutorials/M3-tools.md §6 步骤 4，进阶）：
 * 断言多步工具循环的完整事件序列 —— 日志就是 Trajectory 的素材，顺序不能错。
 *
 * 练习任务：
 *   1) 先跑一遍看绿：pnpm vitest run packages/agent/tests/my-tool-loop.test.ts
 *   2) 把 EXPECTED_TYPES 里的第二个 'tool' 删掉，再跑——测试变红（这就是 RED：
 *      你写错一次工具循环，日志顺序立刻露馅）；
 *   3) 把删掉的那个 'tool' 加回去，再跑——回绿。
 */
describe('M3 教程练习：断言多步工具循环的事件序列', () => {
  it('一次工具往返的日志顺序 = turn/start → user → assistant(toolCalls) → tool(调用) → tool(结果) → assistant → turn/end', async () => {
    const { ctx, dispose } = await createTestContext()
    const fake = createFakeLlm({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'probe', arguments: { k: 'v' } }] },
        { content: '做完了。' },
      ],
    })
    await ctx.plugin(provideLlm, fake)
    await ctx.plugin(provideTools, createToolRegistry())
    ctx.get('tools')!.register({
      declaration: { name: 'probe', description: '练习探针', parameters: { type: 'object' } },
      execute: async (input: Record<string, unknown>) => ({ echo: input }),
    })
    const session = await openSession(ctx, { id: 'my-tools', meta: { id: 'my-tools', title: '', createdAt: 0 } })
    const fiber = await session.ctx.plugin(agentLoop)
    const loop = fiber.ctx['agent-loop']
    try {
      await loop.chat('用工具做件事')

      // ↓↓↓ 练习：改动这里看红绿翻转 ↓↓↓
      const EXPECTED_TYPES = [
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
        'turn/end',
      ]
      // ↑↑↑ 练习：改动这里看红绿翻转 ↑↑↑
      expect(session.log.map((e) => e.type)).toEqual(EXPECTED_TYPES)

      // 两条 tool 事件：调用（只有 input）与结果（带 output）——轨迹检查器靠它们区分"要了什么/得到了什么"
      expect(session.log[4]!.payload).toEqual({ name: 'probe', input: { k: 'v' } })
      expect(session.log[5]!.payload).toEqual({ name: 'probe', input: { k: 'v' }, output: { echo: { k: 'v' } } })

      // 结果回填：模型第二次调用看到了 role:tool 消息
      expect(fake.requests[1]!.messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'c1',
        content: '{"echo":{"k":"v"}}',
      })
    } finally {
      await dispose()
    }
  })
})
