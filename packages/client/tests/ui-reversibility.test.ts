import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { clientShell, uiConversation, uiSessionList, uiTool, uiTrajectory } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/** 占位桥：ui 插件只注册 slot，不发起请求。 */
function fakeBridge(): ClientBridge {
  return {
    request: async <T>() => undefined as T,
    onEvent: () => () => {},
    close: () => {},
  }
}

/**
 * HMR-safety 测试组（M6 决策 6）：dispose 注册方 fiber → 断言注册消失。
 * M6 之前 ui 插件裸注册 slot，卸载后面板句柄残留（ClientRoot 仍会渲染它）。
 */
describe('注册可逆（M6）：ui 插件卸载即撤销 slot', () => {
  it('uiTool fiber dispose 后 tool slot 从注册表消失', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(clientShell, { bridge: fakeBridge() })
      const fiber = await ctx.plugin(uiTool)
      expect(ctx.get('slot-registry')!.slots()).toEqual(['tool'])

      await fiber.dispose()

      expect(ctx.get('slot-registry')!.slots()).toEqual([])
      expect(ctx.get('slot-registry')!.get('tool')).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('四个 ui 插件逐个卸载后注册表清空（组合中的每个注册都可逆）', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(clientShell, { bridge: fakeBridge() })
      const fibers = [
        await ctx.plugin(uiSessionList),
        await ctx.plugin(uiConversation),
        await ctx.plugin(uiTool),
        await ctx.plugin(uiTrajectory),
      ]
      expect([...ctx.get('slot-registry')!.slots()].sort()).toEqual([
        'conversation',
        'session-list',
        'tool',
        'trajectory',
      ])

      for (const fiber of fibers) await fiber.dispose()

      expect(ctx.get('slot-registry')!.slots()).toEqual([])
    } finally {
      await dispose()
    }
  })
})
