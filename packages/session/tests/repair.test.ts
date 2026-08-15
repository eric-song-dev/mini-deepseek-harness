import { describe, expect, it } from 'vitest'
import { repairDanglingTurn } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

const header: SessionEvent = {
  seq: 1, type: 'session/created', ts: 1000, payload: { id: 's-x', title: '', createdAt: 1000 },
}
const turnStart: SessionEvent = { seq: 2, type: 'turn/start', ts: 1001, payload: undefined }

describe('repairDanglingTurn（纯函数：断尾检测 + 补 turn/end）', () => {
  it('日志以 turn/start 收尾时，补一条 turn/end（reason: crash），seq 接续', () => {
    const input = [header, turnStart]
    const { events, repaired } = repairDanglingTurn(input)
    expect(repaired).toMatchObject({ seq: 3, type: 'turn/end', payload: { reason: 'crash' } })
    expect(repaired!.ts).toBeTypeOf('number')
    expect(events).toEqual([header, turnStart, repaired])
    // 原数组不被修改（纯函数）
    expect(input).toHaveLength(2)
  })

  it('日志正常收尾（turn/end）时不补', () => {
    const closed = [header, turnStart, { seq: 3, type: 'turn/end' as const, ts: 1002, payload: { reason: 'done' } }]
    const result = repairDanglingTurn(closed)
    expect(result.repaired).toBeNull()
    expect(result.events).toBe(closed)
  })

  it('日志只有头记录时不补', () => {
    const events = [header]
    const result = repairDanglingTurn(events)
    expect(result.repaired).toBeNull()
    // 无需修复时原引用直接返回（零复制）
    expect(result.events).toBe(events)
  })

  it('日志为空时不补', () => {
    const result = repairDanglingTurn([])
    expect(result.repaired).toBeNull()
    expect(result.events).toEqual([])
  })

  it('断尾 = 有未配对的 turn/start：末尾是 user/tool 也补；正常闭合不补', () => {
    // 崩溃现场最常见的样子：turn/start 之后进程被杀死，日志末尾可能是 user/tool
    const midUser: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: '说到一半……' } },
    ]
    expect(repairDanglingTurn(midUser).repaired).toMatchObject({
      seq: 4, type: 'turn/end', payload: { reason: 'crash' },
    })

    const midTool: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'tool', ts: 1002, payload: { name: 'bash', input: {} } },
    ]
    expect(repairDanglingTurn(midTool).repaired).toMatchObject({
      seq: 4, type: 'turn/end', payload: { reason: 'crash' },
    })

    // 正常闭合：turn/start 后面有配对的 turn/end，不补
    const closed: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: 'x' } },
      { seq: 4, type: 'turn/end', ts: 1003, payload: { reason: 'done' } },
    ]
    const result = repairDanglingTurn(closed)
    expect(result.repaired).toBeNull()
    expect(result.events).toBe(closed)
  })
})
