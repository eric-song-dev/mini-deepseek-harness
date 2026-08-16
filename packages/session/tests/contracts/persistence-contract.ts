import { beforeEach, describe, expect, it } from 'vitest'
import { SessionNotFoundError } from '@mini-dsh/session'
import type { SessionEvent, SessionPersistence } from '@mini-dsh/session'

/**
 * SessionPersistence seam 的契约测试：任何后端实现（现在 JSONL，将来 SQLite）都必须全部通过。
 * 使用方式：`runPersistenceContract(() => createXxxPersistence(...))`，make 每次用例重新创建后端。
 */
export function runPersistenceContract(make: () => SessionPersistence): void {
  let persistence: SessionPersistence
  beforeEach(() => {
    persistence = make()
  })

  describe('SessionPersistence 契约（任何后端实现都必须通过）', () => {
    it('create→append→load 往返：顺序与载荷无损，首条恒为 session/created 头记录', async () => {
      const meta = await persistence.create({ title: '往返' })
      const event: SessionEvent = { seq: 2, type: 'user', ts: 123, payload: { content: '你好' } }
      await persistence.append(meta.id, event)

      const loaded = await persistence.load(meta.id)
      expect(loaded).toHaveLength(2)
      expect(loaded[0]).toMatchObject({ seq: 1, type: 'session/created' })
      expect(loaded[0]!.payload).toEqual(meta)
      expect(loaded[1]).toEqual(event)
    })

    it('create 后 locate 能取回 meta；缺失会话返回 undefined', async () => {
      const meta = await persistence.create({ title: 'x' })
      await expect(persistence.locate(meta.id)).resolves.toEqual(meta)
      await expect(persistence.locate('no-such-id')).resolves.toBeUndefined()
    })

    it('多会话互不串：append/load 只影响自己的会话', async () => {
      const a = await persistence.create({ title: 'a' })
      const b = await persistence.create({ title: 'b' })
      await persistence.append(a.id, { seq: 2, type: 'user', ts: 1, payload: { content: 'A' } })
      await persistence.append(b.id, { seq: 2, type: 'user', ts: 2, payload: { content: 'B' } })

      expect((await persistence.load(a.id)).map((e) => e.payload)).toEqual([a, { content: 'A' }])
      expect((await persistence.load(b.id)).map((e) => e.payload)).toEqual([b, { content: 'B' }])
    })

    it('list 返回全部会话的 meta', async () => {
      const a = await persistence.create({ title: 'a' })
      const b = await persistence.create({ title: 'b' })
      const list = await persistence.list()
      expect(list.map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
      expect(list.map((m) => m.title).sort()).toEqual(['a', 'b'])
    })

    it('load 不存在的会话抛 SessionNotFoundError', async () => {
      await expect(persistence.load('no-such')).rejects.toThrow(SessionNotFoundError)
    })

    it('append 到不存在的会话抛 SessionNotFoundError', async () => {
      await expect(
        persistence.append('no-such', { seq: 2, type: 'user', ts: 1, payload: {} }),
      ).rejects.toThrow(SessionNotFoundError)
    })

    it('create 带谱系字段：meta 携带 parentSessionId/depth，locate 可取回', async () => {
      const meta = await persistence.create({ title: '子会话', parentSessionId: 's-parent', depth: 2 })
      expect(meta.parentSessionId).toBe('s-parent')
      expect(meta.depth).toBe(2)
      await expect(persistence.locate(meta.id)).resolves.toMatchObject({
        parentSessionId: 's-parent',
        depth: 2,
      })
    })

    it('create 带 seed：后端按原样把种子写在头记录之后（seq 平移归 manager）', async () => {
      const seed: SessionEvent[] = [
        { seq: 2, type: 'user', ts: 10, payload: { content: '种子消息' } },
        { seq: 3, type: 'turn/end', ts: 11, payload: { reason: 'done' } },
      ]
      const meta = await persistence.create({ title: 'fork 子会话', seed })
      const loaded = await persistence.load(meta.id)
      expect(loaded).toHaveLength(3)
      expect(loaded[0]).toMatchObject({ seq: 1, type: 'session/created' })
      expect(loaded[1]).toEqual(seed[0])
      expect(loaded[2]).toEqual(seed[1])
    })
  })
}
