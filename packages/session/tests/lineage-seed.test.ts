import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

/**
 * M8 任务 1：会话谱系（parentSessionId/depth）与 fork 种子（seed）。
 *
 * 背景：subagent 的子会话是独立 Session（独立 JSONL、可独立回放），但需要两样新能力：
 * 1. meta 记谱系 —— parentSessionId（谁派生的我）+ depth（第几层委派），只记账不设限；
 * 2. create 支持 seed —— fork 提供方把父日志的"平衡已完成轮次前缀"作为子会话的
 *    初始历史（子 agent 因此能看到父已完成轮次）；spawn 不传 seed（空对话开始）。
 *
 * 种子契约：seed 是调用方给的"已完成轮次前缀"（seq 从 1 连续），manager 负责平移
 * seq（子会话头记录占 seq 1，种子平移为 2..N+1）——resume 重放同前缀、继续追加 seq 连续。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-seed-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Booted {
  ctx: Context
  manager: SessionManager
  dispose: () => Promise<void>
}

/** 启动一套最小 runtime：JSONL 后端 + SessionManager。 */
async function boot(): Promise<Booted> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const manager = ctx.get('session-manager')
  expect(manager).toBeDefined()
  return { ctx, manager: manager!, dispose }
}

/** 一段"父会话已完成的一轮"事件（父日志 2..5 的轮次事件；父头记录由调用方排除）。 */
function completedTurnSeed(): SessionEvent[] {
  return [
    { seq: 2, type: 'turn/start', ts: 2, payload: undefined },
    { seq: 3, type: 'user', ts: 3, payload: { content: '父会话第一轮问题' } },
    { seq: 4, type: 'assistant', ts: 4, payload: { content: '父会话第一轮回答' } },
    { seq: 5, type: 'turn/end', ts: 5, payload: { reason: 'done' } },
  ]
}

describe('M8：会话谱系与 fork 种子', () => {
  it('create 带 parentSessionId/depth 时 meta 携带并随 JSONL 头记录持久化（重启 resume 还在）', async () => {
    let id: string
    {
      const { manager, dispose } = await boot()
      const session = await manager.create({
        title: '子会话',
        parentSessionId: 's-parent',
        depth: 1,
      })
      id = session.id
      expect(session.meta.parentSessionId).toBe('s-parent')
      expect(session.meta.depth).toBe(1)
      await dispose()
    }
    {
      const { manager, dispose } = await boot()
      try {
        const resumed = await manager.resume(id)
        expect(resumed.meta.parentSessionId).toBe('s-parent')
        expect(resumed.meta.depth).toBe(1)
      } finally {
        await dispose()
      }
    }
  })

  it('create 带 seed：内存日志 = 头记录 + 平移种子（seq 2..N+1），继续 emit 从 N+2 续', async () => {
    const { manager, dispose } = await boot()
    try {
      const seed = completedTurnSeed()
      const session = await manager.create({ title: 'fork 子会话', seed })

      // 内存日志：头记录（seq 1）+ 平移后的 4 条种子（seq 2..5），载荷/类型/ts 原样
      expect(session.log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(session.log[1]).toMatchObject({ type: 'turn/start', ts: 2, payload: undefined })
      expect(session.log[2]!.payload).toEqual({ content: '父会话第一轮问题' })

      // 继续追加：seq 从种子之后继续
      session.ctx.emit('user', { content: '子会话的新问题' })
      expect(session.log.at(-1)!.seq).toBe(6)
      expect(session.log.at(-1)!.payload).toEqual({ content: '子会话的新问题' })
    } finally {
      await dispose()
    }
  })

  it('seed 落盘：JSONL 文件行 == 内存日志；模拟重启 resume 重放同前缀', async () => {
    let id: string
    let seed: SessionEvent[]
    {
      const { manager, dispose } = await boot()
      seed = completedTurnSeed()
      const session = await manager.create({ title: 'fork 子会话', seed })
      id = session.id
      session.ctx.emit('user', { content: '接着问' })
      await session.flush()
      await dispose()
    }
    {
      const { manager, dispose } = await boot()
      try {
        const resumed = await manager.resume(id)
        expect(resumed.log.map((e) => e.type)).toEqual([
          'session/created', 'turn/start', 'user', 'assistant', 'turn/end', 'user',
        ])
        expect(resumed.log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
        // 种子载荷原样（父历史的重放 = 同一个已完成轮次）
        expect(resumed.log[3]!.payload).toEqual({ content: '父会话第一轮回答' })
        expect(resumed.log.at(-1)!.payload).toEqual({ content: '接着问' })
      } finally {
        await dispose()
      }
    }
  })

  it('不带 seed 时行为与 M1 一致：日志只有头记录，seq 从 2 续', async () => {
    const { manager, dispose } = await boot()
    try {
      const session = await manager.create({ title: 'spawn 子会话' })
      expect(session.log).toHaveLength(1)
      session.ctx.emit('user', { content: '你好' })
      expect(session.log.at(-1)!.seq).toBe(2)
    } finally {
      await dispose()
    }
  })
})
