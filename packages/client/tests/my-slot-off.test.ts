import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { clientShell, uiTool } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/** 占位桥：本练习只玩 slot 注册表，不发请求。 */
function fakeBridge(): ClientBridge {
  return {
    request: async <T>() => undefined as T,
    onEvent: () => () => {},
    close: () => {},
  }
}

/**
 * M6 教程练习 3：my-slot-off —— slot 的注册与撤销。
 *
 * 红绿翻转（跟着教程做）：
 * 1. 先把第 30 行的期望改成"卸载后 slot 还在"（`toEqual(['tool'])`），跑测试 → 红；
 * 2. 再改回"卸载后注册表为空" → 绿。
 * 红的原因：M6 起 ui 插件经 registerSlot 助手把撤销函数挂上 ctx.effect。
 */
describe('M6 练习 3：卸载 ui 插件即撤销 slot', () => {
  it('卸载 uiTool 后 tool slot 从注册表消失', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(clientShell, { bridge: fakeBridge() })
      const fiber = await ctx.plugin(uiTool)
      expect(ctx.get('slot-registry')!.slots()).toEqual(['tool'])

      await fiber.dispose()

      expect(ctx.get('slot-registry')!.slots()).toEqual([])
    } finally {
      await dispose()
    }
  })
})
