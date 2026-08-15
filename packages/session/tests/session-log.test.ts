import { describe, expect, it } from 'vitest'
import { createEventRecorder, createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionEvent, SessionLog } from '@mini-dsh/session'

describe('session-log 服务（M2：日志真源的只读入口）', () => {
  it('openSession 后会话 ctx 提供 session-log，初始快照即头记录', async () => {
    const { ctx, dispose } = await createTestContext()
    const meta = { id: 's1', title: '', createdAt: 123 }
    const session = await openSession(ctx, { id: 's1', meta })
    try {
      const log: SessionLog = session.ctx['session-log']
      expect(log).toBeDefined()
      expect(log.events).toEqual([
        { seq: 1, type: 'session/created', ts: 123, payload: meta },
      ])
    } finally {
      await dispose()
    }
  })

  it('emit 词汇事件后快照包含新条目（输出写日志、输入读日志走同一个真源）', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } })
    try {
      const log: SessionLog = session.ctx['session-log']
      session.ctx.emit('user', { content: '你好' })
      expect(log.events.map((e) => e.type)).toEqual(['session/created', 'user'])
      expect(log.events[1]!.payload).toEqual({ content: '你好' })
    } finally {
      await dispose()
    }
  })

  it('assistant/stream 分片事件同样经桥接进日志（M4：流式分片也是日志真源的一部分）', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } })
    try {
      const log: SessionLog = session.ctx['session-log']
      session.ctx.emit('assistant/stream', { content: '甲' })
      session.ctx.emit('assistant/stream', { content: '乙' })
      expect(log.events.map((e) => e.type)).toEqual(['session/created', 'assistant/stream', 'assistant/stream'])
      expect(log.events.map((e) => e.payload)).toEqual([
        { id: 's1', title: '', createdAt: 0 },
        { content: '甲' },
        { content: '乙' },
      ])
    } finally {
      await dispose()
    }
  })

  it('session/append 事件（M4）：每次追加日志条目时同步发出，载荷是刚追加的完整条目（含 seq）', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } })
    const recorder = createEventRecorder(session.ctx, ['session/append'])
    try {
      session.ctx.emit('user', { content: '你好' })
      session.ctx.emit('assistant', { content: '你好呀' })
      expect(recorder.eventsOf('session/append').map((event) => event.args[0])).toEqual([
        { seq: 2, type: 'user', ts: expect.any(Number) as unknown, payload: { content: '你好' } },
        { seq: 3, type: 'assistant', ts: expect.any(Number) as unknown, payload: { content: '你好呀' } },
      ])
    } finally {
      await dispose()
    }
  })

  it('快照是副本：修改快照数组不影响内部日志，追加后旧快照不变', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } })
    try {
      const log: SessionLog = session.ctx['session-log']
      const snapshot = log.events
      expect(snapshot).not.toBe(log.events)
      ;(snapshot as SessionEvent[]).length = 0
      expect(log.events).toHaveLength(1)
      session.ctx.emit('user', { content: '新' })
      expect(snapshot).toHaveLength(0)
      expect(log.events).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('并存的多个会话各有各的 session-log（互不串）', async () => {
    const { ctx, dispose } = await createTestContext()
    const a = await openSession(ctx, { id: 'a', meta: { id: 'a', title: '', createdAt: 0 } })
    const b = await openSession(ctx, { id: 'b', meta: { id: 'b', title: '', createdAt: 0 } })
    try {
      a.ctx.emit('user', { content: 'A' })
      const logA: SessionLog = a.ctx['session-log']
      const logB: SessionLog = b.ctx['session-log']
      expect(logA.events.map((e) => e.payload)).toEqual([
        { id: 'a', title: '', createdAt: 0 },
        { content: 'A' },
      ])
      expect(logB.events.map((e) => e.type)).toEqual(['session/created'])
    } finally {
      await dispose()
    }
  })

  it('session-meta 提供会话元信息（M3：loop 从它取工具执行的 cwd）', async () => {
    const { ctx, dispose } = await createTestContext()
    const meta = { id: 's1', title: '标题', createdAt: 123, cwd: '/work' }
    const session = await openSession(ctx, { id: 's1', meta })
    try {
      expect(session.ctx['session-meta']).toEqual(meta)
      // 自有属性遮蔽（与 session-log 同款机制）：并存会话互不串
      const b = await openSession(ctx, { id: 's2', meta: { id: 's2', title: '', createdAt: 0 } })
      expect(b.ctx['session-meta'].id).toBe('s2')
      expect(session.ctx['session-meta'].id).toBe('s1')
    } finally {
      await dispose()
    }
  })
})
