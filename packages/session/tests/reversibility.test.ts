import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { SessionManager, SessionNotFoundError } from '@mini-dsh/session'
import type { SessionEvent, SessionPersistence } from '@mini-dsh/session'

/**
 * HMR-safety 测试组（M6 决策 6）：dispose 注册方 fiber → 断言收尾完成。
 * 会话卸载 = 落盘排空：M6 之前 fiber dispose 不等 pendingWrites 链，排队的
 * 写入可能随进程退出丢失。
 */
describe('注册可逆（M6）：会话卸载即落盘排空', () => {
  it('fiber dispose（不经 session.flush/dispose）等待已 emit 的事件全部落盘', async () => {
    const written: SessionEvent[] = []
    const slowPersistence: SessionPersistence = {
      locate: async () => undefined,
      create: async (input) => ({ id: 's1', title: input.title ?? 't', createdAt: 0 }),
      append: async (_id, event) => {
        // 确定性：每次落盘 50ms——不等待 flush 的卸载会赶在写入完成前返回
        await new Promise((resolve) => setTimeout(resolve, 50))
        written.push(event)
      },
      load: async () => {
        throw new SessionNotFoundError('s1')
      },
      list: async () => [],
    }
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(function provideSlowPersistence(ctx: Context): void {
        ctx.provide('session-persistence', slowPersistence)
      })
      await ctx.plugin(SessionManager)
      const session = await ctx['session-manager'].create({ title: 't' })
      session.ctx.emit('turn/start')
      session.ctx.emit('user', { content: '说到一半' })

      await session.ctx.fiber.dispose()

      expect(written.map((e) => e.type)).toEqual(['turn/start', 'user'])
    } finally {
      await dispose()
    }
  })
})
