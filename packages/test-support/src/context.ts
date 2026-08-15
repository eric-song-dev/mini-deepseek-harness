import { Context } from 'cordis'

export interface TestContext {
  ctx: Context
  /** 关闭测试 ctx（卸载全部插件、清理 effect）。 */
  dispose: () => Promise<void>
}

/**
 * 创建一个全新的 cordis 根 ctx 用于测试。
 * 每个测试用例用独立的 ctx，互不干扰；测试结束调用 dispose 清理。
 */
export async function createTestContext(): Promise<TestContext> {
  const ctx = new Context()
  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}
