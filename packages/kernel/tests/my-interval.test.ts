import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'

/**
 * M6 教程练习 4（进阶）：my-interval —— 给带计时器的插件装 ctx.effect 清理。
 *
 * 红绿翻转（跟着教程做）：
 * 1. 先把第 24–26 行的 `ctx.effect(...)` 整行删掉，跑测试 → 红
 *    （卸载后计时器还在跳，ticks 继续增长）；
 * 2. 再把 effect 行加回来 → 绿。
 * 这就是"注册即 effect"对非注册表资源同样适用：setInterval 也是一种注册。
 */
describe('M6 练习 4：计时器也是注册，卸载即清理', () => {
  it('卸载带 setInterval 的插件后计时器停止触发', async () => {
    const { ctx, dispose } = await createTestContext()
    let ticks = 0
    try {
      const fiber = await ctx.plugin(function ticker(ctx: Context): void {
        const timer = setInterval(() => {
          ticks++
        }, 10)
        ctx.effect(() => () => clearInterval(timer))
      })

      await new Promise((resolve) => setTimeout(resolve, 35))
      const before = ticks
      expect(before).toBeGreaterThan(0)

      await fiber.dispose()
      await new Promise((resolve) => setTimeout(resolve, 35))
      expect(ticks).toBe(before) // 卸载后不再触发
    } finally {
      await dispose()
    }
  })
})
