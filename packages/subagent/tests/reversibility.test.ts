import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { SubagentRuntime } from '@mini-dsh/subagent'
import type { SubagentProvider } from '@mini-dsh/subagent'

/**
 * HMR-safety 测试组（M6 纪律 → M8）：dispose 提供方插件 fiber → 断言注册消失。
 * 上游契约："移除提供方会阻止新的 start，但不会撤销已返回给持有方的 run"——
 * 后半句在任务 4 的 provider 测试里守护。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-subagents-hmr-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function boot(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(SubagentRuntime)
  return { ctx, dispose }
}

/** 注册提供方的插件（M6 纪律：register 返回撤销函数，经 ctx.effect 挂接）。 */
function providerPlugin(provider: SubagentProvider) {
  return Object.assign(function providerPlugin(ctx: Context): void {
    const off = ctx.subagents.registerProvider(provider)
    ctx.effect(() => () => off())
  }, { inject: ['subagents'] })
}

const fake: SubagentProvider = {
  name: 'fake',
  inheritsParentContext: false,
  async start() {
    return {
      id: 'child-1',
      result: Promise.resolve({ output: 'ok', stopReason: 'completed' }),
      dispose: async () => {},
    }
  },
}

describe('注册可逆（M8）：subagents provider 插件卸载即撤销', () => {
  it('provider 插件 fiber dispose 后注册消失、provider-removed 发出、start 抛 NO_PROVIDER', async () => {
    const { ctx, dispose } = await boot()
    try {
      const removed: string[] = []
      ctx.on('subagent/provider-removed', (name) => { removed.push(name) })
      const fiber = await ctx.plugin(providerPlugin(fake))
      expect(ctx.subagents.list()).toEqual(['fake'])

      await fiber.dispose()

      expect(ctx.subagents.getProvider('fake')).toBeUndefined()
      expect(ctx.subagents.list()).toEqual([])
      expect(removed).toEqual(['fake'])
      const session = await ctx.get('session-manager')!.create({ title: '父' })
      await expect(
        ctx.subagents.start('fake', { prompt: '任务', parent: session.ctx }),
      ).rejects.toThrow(/NO_PROVIDER/)
    } finally {
      await dispose()
    }
  })
})
