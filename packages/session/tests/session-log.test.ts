import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionLog } from '@mini-dsh/session'

describe('session-log 服务（M2：日志真源的只读入口）', () => {
  it('openSession 后会话 ctx 提供 session-log 服务，初始快照即头记录', async () => {
    const { ctx, dispose } = await createTestContext()
    const meta = { id: 's1', title: '', createdAt: 123 }
    const session = await openSession(ctx, { id: 's1', meta })
    try {
      const log = session.ctx.get('session-log')!
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
      const log: SessionLog = session.ctx.get('session-log')!
      session.ctx.emit('user', { content: '你好' })
      expect(log.events.map((e) => e.type)).toEqual(['session/created', 'user'])
      expect(log.events[1]!.payload).toEqual({ content: '你好' })
    } finally {
      await dispose()
    }
  })

  it('快照是副本：修改快照数组不影响内部日志，追加后旧快照不变', async () => {
    const { ctx, dispose } = await createTestContext()
    const session = await openSession(ctx, { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } })
    try {
      const log: SessionLog = session.ctx.get('session-log')!
      const snapshot = log.events
      snapshot.length = 0
      expect(log.events).toHaveLength(1)
      session.ctx.emit('user', { content: '新' })
      expect(snapshot).toHaveLength(0)
      expect(log.events).toHaveLength(2)
    } finally {
      await dispose()
    }
  })
})
