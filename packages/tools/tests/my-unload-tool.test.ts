import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { bashTool, toolRegistry } from '@mini-dsh/tools'

/**
 * M6 教程练习 1：my-unload-tool —— 卸载工具插件即撤销注册。
 *
 * 红绿翻转（跟着教程做）：
 * 1. 先把第 19 行的期望改成"卸载后工具还在"（`toContain('bash')`），跑测试 → 红；
 * 2. 再改回"卸载后注册表为空" → 绿。
 * 红的原因：M6 已把 bashTool 的注册改成可撤销（ctx.effect + 撤销函数）。
 */
describe('M6 练习 1：卸载工具插件即撤销注册', () => {
  it('卸载 bashTool 的 fiber 后注册表为空', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(toolRegistry)
      const fiber = await ctx.plugin(bashTool)
      expect(ctx.tools.list().map((t) => t.name)).toContain('bash')

      await fiber.dispose()

      expect(ctx.tools.list()).toEqual([])
    } finally {
      await dispose()
    }
  })
})
