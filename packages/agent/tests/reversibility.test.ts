import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionConfig } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'

/**
 * 注册可逆的端到端形态（M6 spec 任务 6）：卸载工具插件 → loop 的模型可见面
 * 同步消失。"卸载即消失"不只在注册表层，而要贯通 loop → llm.chat 的输入。
 */
describe('注册可逆（M6）：卸载工具即从模型可见面消失（端到端）', () => {
  it('bashTool 卸载后跑一轮 loop：模型收到的 tools 声明为空，会话日志无 tool 事件', async () => {
    const { ctx, dispose } = await createTestContext()
    const fake = createFakeLlm({ replies: [{ content: '完成' }] })
    try {
      await ctx.plugin(provideLlm, fake)
      await ctx.plugin(toolRegistry)
      const bashFiber = await ctx.plugin(bashTool)
      const session = await openSession(ctx, {
        id: 's1',
        meta: { id: 's1', title: '', createdAt: 0 },
      } satisfies SessionConfig)
      const fiber = await session.ctx.plugin(agentLoop)
      const loop = fiber.ctx['agent-loop']

      await bashFiber.dispose()
      await loop.chat('你好')

      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]!.tools.map((t) => t.name)).toEqual([])
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
    } finally {
      await dispose()
    }
  })
})
