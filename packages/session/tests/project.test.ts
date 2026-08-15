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
})
