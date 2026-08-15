import { describe, expect, it } from 'vitest'
import { projectTurns } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

/**
 * M5 教程练习（进阶）：断言 projectTurns 的红绿翻转。
 *
 * 玩法：
 * 1. 跑 `pnpm vitest run --project node packages/session/tests/my-turns.test.ts` —— 绿。
 * 2. 把 events 里第二条分片 `{ seq: 5, ..., content: '好' }` 删掉 —— 红：
 *    分片聚合行只剩 2 片，而断言期望 ×3（chunks: ['你', '好', '呀']）。
 * 3. 加回去 —— 绿。
 *
 * 验收标准：你能解释为什么删掉一条分片会让断言失败（投影把相邻分片合成一条
 * 摘要行，行载荷 = { chunks, joined }；少一片，chunks 就不是 3 片了）。
 */
describe('M5 练习：projectTurns 的断言', () => {
  it('一轮流式对话投影：分片聚合行含全部 3 片与拼接全文，轮耗时 = endedAt - startedAt', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'turn/start', ts: 100, payload: undefined },
      { seq: 3, type: 'user', ts: 110, payload: { content: '讲个故事' } },
      { seq: 4, type: 'assistant/stream', ts: 200, payload: { content: '你' } },
      { seq: 5, type: 'assistant/stream', ts: 230, payload: { content: '好' } },
      { seq: 6, type: 'assistant/stream', ts: 260, payload: { content: '呀' } },
      { seq: 7, type: 'assistant', ts: 300, payload: { content: '你好呀' } },
      { seq: 8, type: 'turn/end', ts: 320, payload: { reason: 'done' } },
    ]

    const turn = projectTurns(events)[0]!
    expect(turn.index).toBe(1)
    expect(turn.userText).toBe('讲个故事')
    expect(turn.durationMs).toBe(220)
    expect(turn.events).toHaveLength(3)

    const streamRow = turn.events.find((e) => e.type === 'assistant/stream')!
    expect(streamRow.payload).toEqual({ chunks: ['你', '好', '呀'], joined: '你好呀' })
  })
})
