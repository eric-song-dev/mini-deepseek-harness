import { describe, expect, it } from 'vitest'
import { repairDanglingTurn } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

const header: SessionEvent = {
  seq: 1, type: 'session/created', ts: 1000, payload: { id: 's-x', title: '', createdAt: 1000 },
}
const turnStart: SessionEvent = { seq: 2, type: 'turn/start', ts: 1001, payload: undefined }

describe('repairDanglingTurn（纯函数：断尾检测 + 补 turn/end + 闭合在途工具调用）', () => {
  it('日志以 turn/start 收尾时，补一条 turn/end（reason: crash），seq 接续', () => {
    const input = [header, turnStart]
    const { events, repaired } = repairDanglingTurn(input)
    expect(repaired).toEqual([
      { seq: 3, type: 'turn/end', ts: 1001, payload: { reason: 'crash' } },
    ])
    expect(events).toEqual([header, turnStart, ...repaired])
    // 原数组不被修改（纯函数）
    expect(input).toHaveLength(2)
  })

  it('日志正常收尾（turn/end）时不补', () => {
    const closed = [header, turnStart, { seq: 3, type: 'turn/end' as const, ts: 1002, payload: { reason: 'done' } }]
    const result = repairDanglingTurn(closed)
    expect(result.repaired).toEqual([])
    expect(result.events).toBe(closed)
  })

  it('日志只有头记录时不补', () => {
    const events = [header]
    const result = repairDanglingTurn(events)
    expect(result.repaired).toEqual([])
    // 无需修复时原引用直接返回（零复制）
    expect(result.events).toBe(events)
  })

  it('日志为空时不补', () => {
    const result = repairDanglingTurn([])
    expect(result.repaired).toEqual([])
    expect(result.events).toEqual([])
  })

  it('断尾 = 有未配对的 turn/start：末尾是 user/tool 也补；正常闭合不补', () => {
    // 崩溃现场最常见的样子：turn/start 之后进程被杀死，日志末尾可能是 user/tool
    const midUser: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: '说到一半……' } },
    ]
    expect(repairDanglingTurn(midUser).repaired).toEqual([
      { seq: 4, type: 'turn/end', ts: 1002, payload: { reason: 'crash' } },
    ])

    const midTool: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'tool', ts: 1002, payload: { name: 'bash', input: {} } },
    ]
    // tool 事件没有对应的 assistant toolCalls（异常日志）：不凭空造结果，只补 turn/end
    expect(repairDanglingTurn(midTool).repaired).toEqual([
      { seq: 4, type: 'turn/end', ts: 1002, payload: { reason: 'crash' } },
    ])

    // 正常闭合：turn/start 后面有配对的 turn/end，不补
    const closed: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: 'x' } },
      { seq: 4, type: 'turn/end', ts: 1003, payload: { reason: 'done' } },
    ]
    const result = repairDanglingTurn(closed)
    expect(result.repaired).toEqual([])
    expect(result.events).toBe(closed)
  })

  it('在途工具调用（已开始、结果没回来）：先合成 isError 结果，再补 turn/end', () => {
    const events: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: '跑个命令' } },
      {
        seq: 4, type: 'assistant', ts: 1003,
        payload: { content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'date' } }] },
      },
      { seq: 5, type: 'tool', ts: 1004, payload: { name: 'bash', input: { command: 'date' } } },
    ]
    const { events: repairedLog, repaired } = repairDanglingTurn(events)

    expect(repaired).toEqual([
      {
        seq: 6, type: 'tool', ts: 1004,
        payload: {
          name: 'bash',
          input: { command: 'date' },
          output: { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' },
        },
      },
      { seq: 7, type: 'turn/end', ts: 1004, payload: { reason: 'crash' } },
    ])
    expect(repairedLog).toEqual([...events, ...repaired])
  })

  it('多调用部分完成：只给没有结果的调用合成错误结果（按声明顺序配对）', () => {
    const events: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: '读并改' } },
      {
        seq: 4, type: 'assistant', ts: 1003,
        payload: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
            { id: 'c2', name: 'edit', arguments: { path: 'a.txt' } },
          ],
        },
      },
      { seq: 5, type: 'tool', ts: 1004, payload: { name: 'read', input: { path: 'a.txt' } } },
      { seq: 6, type: 'tool', ts: 1005, payload: { name: 'read', input: { path: 'a.txt' }, output: { content: 'x' } } },
      { seq: 7, type: 'tool', ts: 1006, payload: { name: 'edit', input: { path: 'a.txt' } } },
    ]
    const { repaired } = repairDanglingTurn(events)

    // c1 已有结果被配对消费；c2 只有调用事件 → 合成 c2 的错误结果
    expect(repaired).toEqual([
      {
        seq: 8, type: 'tool', ts: 1006,
        payload: {
          name: 'edit',
          input: { path: 'a.txt' },
          output: { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' },
        },
      },
      { seq: 9, type: 'turn/end', ts: 1006, payload: { reason: 'crash' } },
    ])
  })

  it('崩溃在 assistant 与任何 tool 事件之间：全部声明调用都合成错误结果（name/arguments 取自声明）', () => {
    const events: SessionEvent[] = [
      header,
      { seq: 2, type: 'turn/start', ts: 1001, payload: undefined },
      { seq: 3, type: 'user', ts: 1002, payload: { content: '两个任务' } },
      {
        seq: 4, type: 'assistant', ts: 1003,
        payload: {
          content: '',
          toolCalls: [
            { id: 'a1', name: 'bash', arguments: { command: 'ls' } },
            { id: 'a2', name: 'read', arguments: { path: 'x' } },
          ],
        },
      },
    ]
    const { repaired } = repairDanglingTurn(events)

    expect(repaired).toEqual([
      {
        seq: 5, type: 'tool', ts: 1003,
        payload: { name: 'bash', input: { command: 'ls' }, output: { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' } },
      },
      {
        seq: 6, type: 'tool', ts: 1003,
        payload: { name: 'read', input: { path: 'x' }, output: { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' } },
      },
      { seq: 7, type: 'turn/end', ts: 1003, payload: { reason: 'crash' } },
    ])
  })
})
