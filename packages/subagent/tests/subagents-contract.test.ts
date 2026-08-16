import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { SubagentError, SubagentRuntime } from '@mini-dsh/subagent'
import type { SubagentProvider, SubagentResult } from '@mini-dsh/subagent'

/**
 * Subagents seam 契约测试（M8 任务 3）：具名 provider 注册表 + start 的生命周期事件对。
 *
 * 契约主题（照搬上游概念）：
 * - 注册表：register/get/list 保序、重名抛 DUPLICATE_PROVIDER、幂等撤销；
 * - provider-added/removed 是注册表事件（服务 ctx 上发出）；
 * - start 对未知 provider 抛 NO_PROVIDER；start 拒绝 = 不 emit 生命周期事件对；
 * - 发布后：subagent/start 与 subagent/end 按 runId 配对，emit 在父会话 ctx
 *   （隔离总线 = 上游 scope-filtered 的 mini 对应物，且不落父日志）。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-subagents-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Booted {
  root: Context
  ctx: Context
  dispose: () => Promise<void>
}

/** 启动最小 runtime：JSONL + SessionManager + SubagentRuntime。 */
async function boot(): Promise<Booted> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(SubagentRuntime)
  const runtime = ctx.get('subagents')
  expect(runtime).toBeDefined()
  return { root: ctx, ctx, dispose }
}

/** 假提供方：start 立刻返回一个已完成的 run（不真跑子 agent）。 */
function fakeProvider(name: string, overrides: Partial<SubagentResult> = {}): SubagentProvider {
  return {
    name,
    inheritsParentContext: false,
    async start() {
      const result: SubagentResult = { output: `${name} 的回答`, stopReason: 'completed', ...overrides }
      return {
        id: `child-${name}-1`,
        result: Promise.resolve(result),
        dispose: async () => {},
      }
    },
  }
}

/** 开一个父会话并把 subagent/* 事件收进数组（父会话隔离总线上的监听器）。 */
async function openParent(ctx: Context): Promise<{ session: Session; seen: unknown[][] }> {
  const manager = ctx.get('session-manager')!
  const session = await manager.create({ title: '父会话' })
  const seen: unknown[][] = []
  session.ctx.on('subagent/start', (...args: unknown[]) => { seen.push(args) })
  session.ctx.on('subagent/end', (...args: unknown[]) => { seen.push(args) })
  return { session, seen }
}

describe('Subagents seam 契约', () => {
  it('register 后 get 可查、list 保持注册顺序、未知名返回 undefined', async () => {
    const { ctx, dispose } = await boot()
    try {
      const a = fakeProvider('a')
      const b = fakeProvider('b')
      ctx.subagents.registerProvider(a)
      ctx.subagents.registerProvider(b)
      expect(ctx.subagents.getProvider('a')).toBe(a)
      expect(ctx.subagents.getProvider('nope')).toBeUndefined()
      expect(ctx.subagents.list()).toEqual(['a', 'b'])
    } finally {
      await dispose()
    }
  })

  it('重名注册抛 DUPLICATE_PROVIDER（防静默覆盖）且不 emit provider-added', async () => {
    const { ctx, dispose } = await boot()
    try {
      const added: string[] = []
      ctx.on('subagent/provider-added', (provider) => { added.push(provider.name) })
      ctx.subagents.registerProvider(fakeProvider('a'))
      expect(() => ctx.subagents.registerProvider(fakeProvider('a'))).toThrow(SubagentError)
      expect((() => {
        try {
          ctx.subagents.registerProvider(fakeProvider('a'))
          return 'no-throw'
        } catch (error) {
          return (error as SubagentError).code
        }
      })()).toBe('DUPLICATE_PROVIDER')
      expect(added).toEqual(['a'])
    } finally {
      await dispose()
    }
  })

  it('register 返回幂等撤销函数：撤销后 get/list 不可见、start 抛 NO_PROVIDER、同名可重注册', async () => {
    const { ctx, dispose } = await boot()
    try {
      const off = ctx.subagents.registerProvider(fakeProvider('a'))
      const removed: string[] = []
      ctx.on('subagent/provider-removed', (name) => { removed.push(name) })
      off()
      off() // 幂等：重复撤销无害
      expect(ctx.subagents.getProvider('a')).toBeUndefined()
      expect(ctx.subagents.list()).toEqual([])
      expect(removed).toEqual(['a'])

      const { session } = await openParent(ctx)
      await expect(
        ctx.subagents.start('a', { prompt: '任务', parent: session.ctx }),
      ).rejects.toThrow(/NO_PROVIDER/)

      // 同名可重注册
      ctx.subagents.registerProvider(fakeProvider('a'))
      expect(ctx.subagents.list()).toEqual(['a'])
    } finally {
      await dispose()
    }
  })

  it('start 把请求转发给具名 provider；发布后 emit subagent/start（父会话 ctx 的隔离总线）', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.subagents.registerProvider(fakeProvider('spawn'))
      const { session, seen } = await openParent(ctx)

      const run = await ctx.subagents.start('spawn', { label: '子任务', prompt: '请回答', parent: session.ctx })
      expect(run.id).toBe('child-spawn-1')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual([{ runId: 'child-spawn-1', provider: 'spawn', id: 'child-spawn-1', local: true }])

      // 只观察不落父日志：父会话日志没有被 subagent/* 污染
      expect(session.log.filter((e) => e.type.startsWith('subagent/'))).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('result 停稳后 emit subagent/end（同 runId，带 stopReason 与最后输出）', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.subagents.registerProvider(fakeProvider('spawn'))
      const { session, seen } = await openParent(ctx)

      const run = await ctx.subagents.start('spawn', { prompt: '请回答', parent: session.ctx })
      const result = await run.result
      expect(result).toEqual({ output: 'spawn 的回答', stopReason: 'completed' })
      expect(seen).toHaveLength(2)
      expect(seen[1]).toEqual([{
        runId: 'child-spawn-1',
        provider: 'spawn',
        id: 'child-spawn-1',
        local: true,
        stopReason: 'completed',
        lastAssistantMessage: 'spawn 的回答',
      }])
    } finally {
      await dispose()
    }
  })

  it('start 拒绝 = 不 emit 生命周期事件对（未发布资源已清理）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const failing: SubagentProvider = {
        name: 'bad',
        inheritsParentContext: false,
        async start() {
          throw new Error('启动失败')
        },
      }
      ctx.subagents.registerProvider(failing)
      const { session, seen } = await openParent(ctx)
      await expect(
        ctx.subagents.start('bad', { prompt: '任务', parent: session.ctx }),
      ).rejects.toThrow('启动失败')
      expect(seen).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('result 意外 reject 时事件对仍闭合（end 记 error，基础设施故障不留下孤儿 start）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const crashing: SubagentProvider = {
        name: 'boom',
        inheritsParentContext: false,
        async start() {
          return {
            id: 'child-boom-1',
            result: Promise.reject(new Error('基础设施故障')),
            dispose: async () => {},
          }
        },
      }
      ctx.subagents.registerProvider(crashing)
      const { session, seen } = await openParent(ctx)

      const run = await ctx.subagents.start('boom', { prompt: '任务', parent: session.ctx })
      await expect(run.result).rejects.toThrow('基础设施故障')
      expect(seen).toHaveLength(2)
      expect(seen[1]).toEqual([{
        runId: 'child-boom-1',
        provider: 'boom',
        id: 'child-boom-1',
        local: true,
        stopReason: 'error',
        lastAssistantMessage: undefined,
      }])
    } finally {
      await dispose()
    }
  })
})
