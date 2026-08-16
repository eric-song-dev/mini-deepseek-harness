import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { createToolRegistry, provideTools, UnknownToolError } from '@mini-dsh/tools'
import { createSkillsRegistry, provideSkills, skillTool } from '@mini-dsh/skill'

/**
 * HMR-safety 测试组（M6 决策 6）：dispose 注册方 fiber → 断言注册消失。
 * skillTool 挂到 tools seam 的注册必须在卸载时撤销，否则卸载后模型仍能
 * "看到"并调用一个已死插件的工具。
 */
describe('注册可逆（M6）：skillTool 卸载即撤销', () => {
  it('skillTool fiber dispose 后 tools 注册表不含 skill 工具、execute 抛 UnknownToolError', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(provideTools, createToolRegistry())
      await ctx.plugin(provideSkills, createSkillsRegistry())
      const fiber = await ctx.plugin(skillTool)
      expect(ctx.get('tools')!.list().map((d) => d.name)).toEqual(['skill'])

      await fiber.dispose()

      expect(ctx.get('tools')!.list()).toEqual([])
      await expect(
        ctx.get('tools')!.execute('skill', { action: 'list' }, { cwd: '/' }),
      ).rejects.toBeInstanceOf(UnknownToolError)
    } finally {
      await dispose()
    }
  })
})
