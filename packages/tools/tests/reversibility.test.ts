import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { bashTool, toolRegistry, UnknownToolError } from '@mini-dsh/tools'

/**
 * HMR-safety 测试组（M6 决策 6）：dispose 注册方 fiber → 断言注册消失。
 * 上游 testing.md 纪律："Every registry gets an HMR-safety test
 * (dispose the contributing fiber, assert cleanup)"。
 *
 * 历史背景：M6 之前这些用例是红的——卸载 bashTool 的 fiber 后 bash 仍留在
 * 注册表里（实测复现），违背上游 "registrations are effects"。
 */
describe('注册可逆（M6）：工具插件卸载即撤销', () => {
  it('bashTool fiber dispose 后工具从注册表消失、execute 抛 UnknownToolError', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(toolRegistry)
      const fiber = await ctx.plugin(bashTool)
      expect(ctx.tools.list().map((t) => t.name)).toEqual(['bash'])

      await fiber.dispose()

      expect(ctx.tools.list()).toEqual([])
      expect(ctx.tools.get('bash')).toBeUndefined()
      await expect(
        ctx.tools.execute('bash', { command: 'echo hi' }, { cwd: process.cwd() }),
      ).rejects.toBeInstanceOf(UnknownToolError)
    } finally {
      await dispose()
    }
  })
})
