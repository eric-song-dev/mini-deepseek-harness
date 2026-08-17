import { describe, expect, it } from 'vitest'
import { projectMessages } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

describe('projectMessages（M2：日志投影成模型 messages）', () => {
  it('user/assistant 事件按日志顺序映射成消息，其余事件全部跳过', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 0, payload: { id: 's', title: '', createdAt: 0 } },
      { seq: 2, type: 'turn/start', ts: 1, payload: undefined },
      { seq: 3, type: 'user', ts: 2, payload: { content: '你好' } },
      { seq: 4, type: 'assistant', ts: 3, payload: { content: '你好呀' } },
      { seq: 5, type: 'tool', ts: 4, payload: { name: 'bash', input: {} } },
      { seq: 6, type: 'turn/end', ts: 5, payload: { reason: 'done' } },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ])
  })

  it('传入 systemPrompt 时拼在消息头部', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'user', ts: 1, payload: { content: '在吗' } },
    ]

    expect(projectMessages(events, { systemPrompt: '你是教学助手' })).toEqual([
      { role: 'system', content: '你是教学助手' },
      { role: 'user', content: '在吗' },
    ])
  })

  it('不传 systemPrompt（或为空）时不产生 system 消息', () => {
    const events: SessionEvent[] = [{ seq: 2, type: 'user', ts: 1, payload: { content: '在吗' } }]
    expect(projectMessages(events)).toEqual([{ role: 'user', content: '在吗' }])
    expect(projectMessages(events, { systemPrompt: '' })).toEqual([{ role: 'user', content: '在吗' }])
  })

  it('空日志投影成空数组', () => {
    expect(projectMessages([])).toEqual([])
  })

  it('assistant/stream 分片事件跳过（M4：模型输入用最终 assistant 全文，不用分片）', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'user', ts: 1, payload: { content: '在吗' } },
      { seq: 3, type: 'assistant/stream', ts: 2, payload: { content: '你' } },
      { seq: 4, type: 'assistant/stream', ts: 3, payload: { content: '好' } },
      { seq: 5, type: 'assistant', ts: 4, payload: { content: '你好' } },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '你好' },
    ])
  })

  it('悬空工具调用（有 toolCalls 声明但结果缺失）在投影末尾补 isError 错误结果：transcript 始终 wire 合法', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'user', ts: 1, payload: { content: '读文件' } },
      {
        seq: 3,
        type: 'assistant',
        ts: 2,
        payload: { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      },
      { seq: 4, type: 'tool', ts: 3, payload: { name: 'read_file', input: { path: 'a.txt' } } },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"isError":true,"content":"工具结果丢失：日志中该调用没有结果记录"}' },
    ])
  })

  it('前一轮悬空调用 + 新一轮 assistant(toolCalls)：旧调用先补错误结果再进入新 assistant（配对不错位）', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'user', ts: 1, payload: { content: '第一轮' } },
      {
        seq: 3,
        type: 'assistant',
        ts: 2,
        payload: { content: '', toolCalls: [{ id: 'old', name: 'bash', arguments: { command: 'ls' } }] },
      },
      // 结果没落（crash/limit），旧轮就此结束
      { seq: 4, type: 'turn/end', ts: 3, payload: { reason: 'limit' } },
      { seq: 5, type: 'turn/start', ts: 4, payload: undefined },
      { seq: 6, type: 'user', ts: 5, payload: { content: '第二轮' } },
      {
        seq: 7,
        type: 'assistant',
        ts: 6,
        payload: { content: '', toolCalls: [{ id: 'new', name: 'read_file', arguments: { path: 'b.txt' } }] },
      },
      { seq: 8, type: 'tool', ts: 7, payload: { name: 'read_file', input: { path: 'b.txt' }, output: { content: 'ok' } } },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: '第一轮' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old', name: 'bash', arguments: { command: 'ls' } }],
      },
      // 错误结果紧跟悬空的 assistant 声明（wire 要求 tool 结果直接紧随）
      { role: 'tool', toolCallId: 'old', content: '{"isError":true,"content":"工具结果丢失：日志中该调用没有结果记录"}' },
      { role: 'user', content: '第二轮' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'new', name: 'read_file', arguments: { path: 'b.txt' } }],
      },
      { role: 'tool', toolCallId: 'new', content: '{"content":"ok"}' },
    ])
  })

  it('tool 结果事件映射成 role:tool 消息：toolCallId 按 assistant toolCalls 顺序配对，content 为 output 的 JSON 串', () => {
    const events: SessionEvent[] = [
      { seq: 2, type: 'user', ts: 1, payload: { content: '办两件事' } },
      {
        seq: 3,
        type: 'assistant',
        ts: 2,
        payload: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } },
            { id: 'c2', name: 'edit_file', arguments: { path: 'a.txt', oldText: 'x', newText: 'y' } },
          ],
        },
      },
      { seq: 4, type: 'tool', ts: 3, payload: { name: 'read_file', input: { path: 'a.txt' } } },
      { seq: 5, type: 'tool', ts: 4, payload: { name: 'read_file', input: { path: 'a.txt' }, output: { content: '内容' } } },
      {
        seq: 6,
        type: 'tool',
        ts: 5,
        payload: { name: 'edit_file', input: { path: 'a.txt' }, output: { replaced: true } },
      },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: '办两件事' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'c2', name: 'edit_file', arguments: { path: 'a.txt', oldText: 'x', newText: 'y' } },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"content":"内容"}' },
      { role: 'tool', toolCallId: 'c2', content: '{"replaced":true}' },
    ])
  })

  it('没有可配对的 toolCalls 时的孤立结果事件：合成 tool-<seq> id（历史不丢消息）', () => {
    const events: SessionEvent[] = [
      {
        seq: 9,
        type: 'tool',
        ts: 1,
        payload: { name: 'bash', input: { command: 'ls' }, output: { exitCode: 0 } },
      },
    ]

    expect(projectMessages(events)).toEqual([
      { role: 'tool', toolCallId: 'tool-9', content: '{"exitCode":0}' },
    ])
  })
})
