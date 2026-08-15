import { describe, expect, it } from 'vitest'
import { repairDanglingTurn } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

const header: SessionEvent = {
  seq: 1, type: 'session/created', ts: 1000, payload: { id: 's-x', title: '', createdAt: 1000 },
}
const turnStart: SessionEvent = { seq: 2, type: 'turn/start', ts: 1001, payload: undefined }

describe('repairDanglingTurn（纯函数：断尾检测 + 补 turn/end）', () => {
  it('日志以 turn/start 收尾时，补一条 turn/end（reason: crash），seq 接续', () => {
    const { events, repaired } = repairDanglingTurn([header, turnStart])
    expect(repaired).toMatchObject({ seq: 3, type: 'turn/end', payload: { reason: 'crash' } })
    expect(repaired!.ts).toBeTypeOf('number')
    expect(events).toEqual([header, turnStart, repaired])
    // 原数组不被修改（纯函数）
    expect([header, turnStart]).toHaveLength(2)
  })

  it('日志正常收尾（turn/end）时不补', () => {
    const closed = [header, turnStart, { seq: 3, type: 'turn/end' as const, ts: 1002, payload: { reason: 'done' } }]
    const result = repairDanglingTurn(closed)
    expect(result.repaired).toBeNull()
    expect(result.events).toBe(closed)
  })

  it('日志只有头记录时不补', () => {
    const result = repairDanglingTurn([header])
    expect(result.repaired).toBeNull()
    expect(result.events).toBe([header])
  })

  it('日志为空时不补', () => {
    const result = repairDanglingTurn([])
    expect(result.repaired).toBeNull()
    expect(result.events).toEqual([])
  })

  it('断尾修复只认最后一条：末尾是 user 不补，末尾是 turn/start 才补', () => {
    const danglingUser = [header, { seq: 2, type: 'user' as const, ts: 1001, payload: { content: 'x' } }]
    expect(repairDanglingTurn(danglingUser).repaired).toBeNull()

    const danglingTool = [header, { seq: 2, type: 'tool' as const, ts: 1001, payload: { name: 'bash', input: {} } }]
    expect(repairDanglingTurn(danglingTool).repaired).toBeNull()

    const danglingStart = [header, { seq: 2, type: 'turn/start' as const, ts: 1001, payload: undefined }]
    expect(repairDanglingTurn(danglingStart).repaired).toMatchObject({
      seq: 3, type: 'turn/end', payload: { reason: 'crash' },
    })
  })
})
