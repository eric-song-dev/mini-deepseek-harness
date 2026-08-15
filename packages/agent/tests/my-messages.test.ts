import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { agentLoop } from '@mini-dsh/agent'

/**
 * M2 教程练习（docs/tutorials/M2-llm-and-loop.md §6 步骤 4）：
 * 断言"模型收到的 messages"精确内容 —— 假 LLM 的 requests 记录是观测窗口。
 *
 * 练习任务：
 *   1) 先跑一遍看绿：pnpm vitest run packages/agent/tests/my-messages.test.ts
 *   2) 把 REPLIES 的第二句改成 '另一种回答'，再跑——测试变红（这就是 RED）；
 *   3) 把第 3 条断言（第二轮输入）的期望改成你改后的答案，再跑——回绿。
 */
describe('M2 教程练习：断言模型收到的 messages', () => {
  it('两轮对话：第二轮输入 == 第一轮问答 + 新问题', async () => {
    const REPLIES = ['第一轮回答', '第二轮回答']
    const { ctx, dispose } = await createTestContext()
    const fake = createFakeLlm({ replies: REPLIES.map((content) => ({ content })) })
    await ctx.plugin(provideLlm, fake)
    const session = await openSession(ctx, { id: 'my', meta: { id: 'my', title: '', createdAt: 0 } })
    const fiber = await session.ctx.plugin(agentLoop)
    const loop = fiber.ctx['agent-loop']
    try {
      await loop.chat('第一问')
      await loop.chat('第二问')

      // 第一轮：模型只看到一个问题
      expect(fake.requests[0]!.messages).toEqual([{ role: 'user', content: '第一问' }])
      // 第二轮：模型看到完整历史（日志投影）——这就是"输入读日志"
      expect(fake.requests[1]!.messages).toEqual([
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '第二问' },
      ])
      // 日志顺序：两轮完整、互不错位
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
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
