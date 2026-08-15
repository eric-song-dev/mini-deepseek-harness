import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { Session, SessionEvent, SessionMeta, SessionPersistence } from '@mini-dsh/session'

const meta: SessionMeta = { id: 's-test', title: '', createdAt: 1000 }

describe('Session：append-only 日志 + emit→append 桥接', () => {
  it('emit 词汇事件按序追加进日志，seq 单调递增、载荷无损', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: meta.id, meta })
    try {
      session.ctx.emit('turn/start')
      session.ctx.emit('user', { content: '你好' })
      session.ctx.emit('assistant', { content: '你好呀' })
      session.ctx.emit('turn/end', { reason: 'done' })

      expect(session.log.map((event) => event.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(session.log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
      expect(session.log[2]).toMatchObject({ type: 'user', payload: { content: '你好' } })
      expect(session.log.at(-1)).toMatchObject({ type: 'turn/end', payload: { reason: 'done' } })
    } finally {
      await dispose()
    }
  })

  it('日志是 append-only：对外只读，没有修改/删除 API（类型层）', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: meta.id, meta })
    try {
      expectTypeOf<Session['log']>().toEqualTypeOf<readonly SessionEvent[]>()
      // @ts-expect-error 日志是 readonly 数组：push/splice 等修改 API 是编译错误
      session.log.push({ seq: 99, type: 'user', ts: 0, payload: {} })
    } finally {
      await dispose()
    }
  })

  it('dispose 后桥接摘除：再 emit 不再记录', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: meta.id, meta })
    session.ctx.emit('user', { content: 'before' })
    await session.dispose()
    session.ctx.emit('user', { content: 'after' })
    expect(session.log.map((event) => event.type)).toEqual(['session/created', 'user'])
    expect(session.log.at(-1)!.payload).toEqual({ content: 'before' })
    await dispose()
  })

  it('注入已加载 events 时 seq 从上次继续（resume 语义）', async () => {
    const { ctx, dispose } = await createTestContext()
    const loaded: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 1000, payload: meta },
      { seq: 2, type: 'user', ts: 1001, payload: { content: '之前说的话' } },
    ]
    const session = await openSession(ctx, { id: meta.id, meta, events: loaded })
    try {
      session.ctx.emit('assistant', { content: '继续聊' })
      expect(session.log.map((event) => event.seq)).toEqual([1, 2, 3])
      expect(session.log.at(-1)!.payload).toEqual({ content: '继续聊' })
    } finally {
      await dispose()
    }
  })

  it('桥接把每条事件交给 persistence.append（顺序一致，flush 可等待）', async () => {
    const { ctx, dispose } = await createTestContext()
    const appended: SessionEvent[] = []
    const persistence = {
      append: vi.fn(async (_id: string, event: SessionEvent) => {
        appended.push(event)
      }),
    } as unknown as SessionPersistence
    const session = await openSession(ctx, { id: meta.id, meta, persistence })
    try {
      session.ctx.emit('turn/start')
      session.ctx.emit('user', { content: 'x' })
      session.ctx.emit('turn/end', { reason: 'done' })
      await session.flush()
      expect(persistence.append).toHaveBeenCalledTimes(3)
      expect(appended.map((event) => event.type)).toEqual(['turn/start', 'user', 'turn/end'])
      expect(appended.map((event) => event.seq)).toEqual([2, 3, 4])
      expect(appended[1]!.payload).toEqual({ content: 'x' })
    } finally {
      await dispose()
    }
  })

  it('emit 方不知道谁在记录：桥接监听器挂在会话自己的 ctx 上', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: meta.id, meta })
    try {
      // 会话自己的子 ctx 与根 ctx 是两个对象（子 ctx 继承根的服务）
      expect(session.ctx).not.toBe(ctx)
      session.ctx.emit('user', { content: 'hi' })
      expect(session.log).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('并存的多个会话互不串台：每个桥接只记自己 ctx 上 emit 的事件', async () => {
    const { ctx, dispose } = await createTestContext()
    const a = await openSession(ctx, { id: 's-a', meta: { ...meta, id: 's-a' } })
    const b = await openSession(ctx, { id: 's-b', meta: { ...meta, id: 's-b' } })
    try {
      a.ctx.emit('user', { content: 'A 说的' })
      b.ctx.emit('user', { content: 'B 说的' })

      expect(a.log.map((e) => e.type)).toEqual(['session/created', 'user'])
      expect(a.log.at(-1)!.payload).toEqual({ content: 'A 说的' })
      expect(b.log.map((e) => e.type)).toEqual(['session/created', 'user'])
      expect(b.log.at(-1)!.payload).toEqual({ content: 'B 说的' })
    } finally {
      await dispose()
    }
  })
})
