import { describe, expect, expectTypeOf, it } from 'vitest'
import { projectTurns } from '@mini-dsh/session'
import type { ProjectedTurn } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

/**
 * projectTurns（M5）：日志 → 按轮分组的轨迹投影。
 * 契约测试逐字段锁定：轮切块、事件摘要（seq/type/ts/耗时）、分片聚合、
 * 断尾语义（M1 修复同款）、旧日志 usage 兜底。client 的轨迹面板与 demo 都消费这个投影。
 */

describe('projectTurns（M5：日志投影成按轮分组的轨迹）', () => {
  it('单轮切块：turn/start..turn/end 成一轮，头记录与轮外事件忽略', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 0, payload: { id: 's', title: '', createdAt: 0 } },
      { seq: 2, type: 'turn/start', ts: 1000, payload: undefined },
      { seq: 3, type: 'user', ts: 1100, payload: { content: '你好' } },
      { seq: 4, type: 'assistant', ts: 1150, payload: { content: '你好呀' } },
      { seq: 5, type: 'turn/end', ts: 1200, payload: { reason: 'done' } },
    ]

    expect(projectTurns(events)).toEqual([
      {
        index: 1,
        userText: '你好',
        startedAt: 1000,
        endedAt: 1200,
        durationMs: 200,
        endReason: 'done',
        events: [
          { seq: 3, type: 'user', ts: 1100, durationMs: 100, payload: { content: '你好' } },
          { seq: 4, type: 'assistant', ts: 1150, durationMs: 50, payload: { content: '你好呀' } },
        ],
      },
    ])
  })

  it('事件摘要的耗时 = 与上一条的 ts 差（轮内首条基准是 turn/start 的 ts）', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 500, payload: undefined },
      { seq: 3, type: 'user', ts: 600, payload: { content: '在吗' } },
      { seq: 4, type: 'tool', ts: 650, payload: { name: 'bash', input: { command: 'pwd' } } },
      { seq: 5, type: 'tool', ts: 900, payload: { name: 'bash', input: { command: 'pwd' }, output: { exitCode: 0 } } },
      { seq: 6, type: 'turn/end', ts: 901, payload: { reason: 'done' } },
    ]

    const turn = projectTurns(events)[0]!
    expect(turn.events.map((e) => e.durationMs)).toEqual([100, 50, 250])
    expect(turn.durationMs).toBe(401)
  })

  it('连续 assistant/stream 分片聚合成一条摘要行（chunks + 拼接全文），终事件仍是独立行', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 100, payload: undefined },
      { seq: 3, type: 'user', ts: 110, payload: { content: '讲个故事' } },
      { seq: 4, type: 'assistant/stream', ts: 200, payload: { content: '你' } },
      { seq: 5, type: 'assistant/stream', ts: 230, payload: { content: '好' } },
      { seq: 6, type: 'assistant/stream', ts: 260, payload: { content: '呀' } },
      { seq: 7, type: 'assistant', ts: 300, payload: { content: '你好呀' } },
      { seq: 8, type: 'turn/end', ts: 320, payload: { reason: 'done' } },
    ]

    expect(projectTurns(events)[0]!.events).toEqual([
      { seq: 3, type: 'user', ts: 110, durationMs: 10, payload: { content: '讲个故事' } },
      {
        seq: 4,
        type: 'assistant/stream',
        ts: 200,
        durationMs: 60,
        payload: { chunks: ['你', '好', '呀'], joined: '你好呀' },
      },
      { seq: 7, type: 'assistant', ts: 300, durationMs: 40, payload: { content: '你好呀' } },
    ])
  })

  it('多轮：按日志顺序切出多个轮次，index 从 1 递增、互不错位', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 10, payload: undefined },
      { seq: 3, type: 'user', ts: 11, payload: { content: '第一问' } },
      { seq: 4, type: 'assistant', ts: 12, payload: { content: '第一答' } },
      { seq: 5, type: 'turn/end', ts: 13, payload: { reason: 'done' } },
      { seq: 6, type: 'turn/start', ts: 20, payload: undefined },
      { seq: 7, type: 'user', ts: 21, payload: { content: '第二问' } },
      { seq: 8, type: 'assistant', ts: 22, payload: { content: '第二答' } },
      { seq: 9, type: 'turn/end', ts: 23, payload: { reason: 'done' } },
    ]

    expect(projectTurns(events).map((t) => [t.index, t.userText, t.startedAt, t.endedAt])).toEqual([
      [1, '第一问', 10, 13],
      [2, '第二问', 20, 23],
    ])
  })

  it('断尾（有未配对 turn/start）：按 M1 修复语义投影成 endReason: crash 的最后一轮', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 30, payload: undefined },
      { seq: 3, type: 'user', ts: 31, payload: { content: '聊到一半崩了' } },
      { seq: 4, type: 'assistant', ts: 32, payload: { content: '回答了一半…' } },
    ]

    expect(projectTurns(events)[0]).toEqual({
      index: 1,
      userText: '聊到一半崩了',
      startedAt: 30,
      endedAt: 32,
      durationMs: 2,
      endReason: 'crash',
      events: [
        { seq: 3, type: 'user', ts: 31, durationMs: 1, payload: { content: '聊到一半崩了' } },
        { seq: 4, type: 'assistant', ts: 32, durationMs: 1, payload: { content: '回答了一半…' } },
      ],
    })
  })

  it('turn/end 的 reason 原样透出（done / limit / crash 是检查器要区分的三种收尾）', () => {
    const base: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 1, payload: undefined },
      { seq: 3, type: 'user', ts: 2, payload: { content: 'q' } },
    ]
    const ends: Array<SessionEvent['payload']> = [
      { reason: 'done' }, { reason: 'limit' }, { reason: 'crash' },
    ]
    expect(
      ends.map((payload) => projectTurns([...base, { seq: 4, type: 'turn/end', ts: 3, payload }])[0]!.endReason),
    ).toEqual(['done', 'limit', 'crash'])
  })

  it('旧日志（M2–M4）assistant 无 usage：投影原样保留载荷、不发明字段（UI 兜底显示 —）', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 1, payload: undefined },
      { seq: 3, type: 'user', ts: 2, payload: { content: '旧会话' } },
      { seq: 4, type: 'assistant', ts: 3, payload: { content: '旧回复' } },
      { seq: 5, type: 'turn/end', ts: 4, payload: { reason: 'done' } },
    ]
    const turn = projectTurns(events)[0]!
    expect(turn.events[1]).toEqual({
      seq: 4, type: 'assistant', ts: 3, durationMs: 1, payload: { content: '旧回复' },
    })
    expectTypeOf(turn).toMatchTypeOf<ProjectedTurn>()
  })

  it('轮内无 user 事件（异常日志）：userText 为 null，轮次照常切出', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 1, payload: undefined },
      { seq: 3, type: 'assistant', ts: 2, payload: { content: '没人问也答' } },
      { seq: 4, type: 'turn/end', ts: 3, payload: { reason: 'done' } },
    ]
    expect(projectTurns(events)[0]!.userText).toBeNull()
  })

  it('空日志投影成空数组', () => {
    expect(projectTurns([])).toEqual([])
  })
})
