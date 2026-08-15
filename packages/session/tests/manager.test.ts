import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager, SessionNotFoundError } from '@mini-dsh/session'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-manager-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Booted {
  ctx: Context
  manager: SessionManager
  dispose: () => Promise<void>
}

/** 启动一套最小 runtime：JSONL 后端 + SessionManager（模拟一次"进程启动"）。 */
async function boot(): Promise<Booted> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const manager = ctx.get('session-manager')
  expect(manager).toBeDefined()
  return { ctx, manager: manager!, dispose }
}

describe('SessionManager', () => {
  it('create 落盘并返回可 emit 的 Session：日志以 session/created 开头', async () => {
    const { manager, dispose } = await boot()
    try {
      const session = await manager.create({ title: '第一次会话' })
      expect(session.meta).toMatchObject({ title: '第一次会话' })
      expect(session.log).toHaveLength(1)
      expect(session.log[0]).toMatchObject({ seq: 1, type: 'session/created' })

      session.ctx.emit('user', { content: '你好' })
      await session.flush()
      expect(session.log).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('模拟重启后 resume：历史完整、可继续追加（seq 从上次继续）', async () => {
    // 第一次"进程"：创建会话，聊一轮
    let id: string
    {
      const { manager, dispose } = await boot()
      const session = await manager.create({ title: '可恢复会话' })
      id = session.id
      session.ctx.emit('turn/start')
      session.ctx.emit('user', { content: '第一轮' })
      session.ctx.emit('assistant', { content: '回复第一轮' })
      session.ctx.emit('turn/end', { reason: 'done' })
      await session.flush()
      await dispose()
    }

    // 第二次"进程"（新 ctx、新 manager）：resume 同一个会话
    const { manager, dispose } = await boot()
    try {
      const resumed = await manager.resume(id)
      expect(resumed.meta).toMatchObject({ id, title: '可恢复会话' })
      expect(resumed.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(resumed.log.at(-1)!.payload).toEqual({ reason: 'done' })

      // 继续追加：seq 从 5 之后继续
      resumed.ctx.emit('user', { content: '接着聊' })
      expect(resumed.log.at(-1)!.seq).toBe(6)

      // 并且追加的内容也落盘了（第三次进程能看到）
      await resumed.flush()
      await dispose()
      {
        const again = await boot()
        const third = await again.manager.resume(id)
        expect(third.log.at(-1)!.payload).toEqual({ content: '接着聊' })
        await again.dispose()
      }
    } finally {
      await dispose()
    }
  })

  it('list 交给 persistence：返回全部会话的 meta', async () => {
    const { manager, dispose } = await boot()
    try {
      const a = await manager.create({ title: 'a' })
      const b = await manager.create({ title: 'b' })
      const list = await manager.list()
      expect(list.map((m) => m.title).sort()).toEqual(['a', 'b'])
      expect(list.map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
      // 排序契约：按 createdAt 倒序（新的在前）；同毫秒创建的先后不保证
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1]!.createdAt).toBeGreaterThanOrEqual(list[i]!.createdAt)
      }
    } finally {
      await dispose()
    }
  })

  it('resume 不存在的会话抛 SessionNotFoundError', async () => {
    const { manager, dispose } = await boot()
    try {
      await expect(manager.resume('no-such')).rejects.toThrow(SessionNotFoundError)
    } finally {
      await dispose()
    }
  })

  it('create 带 cwd 时 meta 携带并随 JSONL 头记录持久化（重启 resume 还在）', async () => {
    let id: string
    {
      const { manager, dispose } = await boot()
      const session = await manager.create({ title: 'cwd 会话', cwd: '/custom/work' })
      id = session.id
      expect(session.meta.cwd).toBe('/custom/work')
      await dispose()
    }
    {
      const { manager, dispose } = await boot()
      try {
        const resumed = await manager.resume(id)
        expect(resumed.meta.cwd).toBe('/custom/work')
      } finally {
        await dispose()
      }
    }
  })

  it('create 不带 cwd 时默认进程 cwd', async () => {
    const { manager, dispose } = await boot()
    try {
      const session = await manager.create({ title: '默认 cwd' })
      expect(session.meta.cwd).toBe(process.cwd())
    } finally {
      await dispose()
    }
  })
})
