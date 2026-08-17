import { describe, expect, it } from 'vitest'
import { projectConversation, projectToolCards } from '@mini-dsh/client'
import type { SessionEvent } from '@mini-dsh/session'

const ev = (seq: number, type: SessionEvent['type'], payload: unknown): SessionEvent => ({ seq, type, ts: 0, payload })

describe('projectConversation（M4：日志投影成对话气泡）', () => {
  it('user/assistant 事件映射成气泡；turn/*、session/created、tool 全部跳过', () => {
    const events = [
      ev(1, 'session/created', { id: 's', title: '', createdAt: 0 }),
      ev(2, 'turn/start', undefined),
      ev(3, 'user', { content: '你好' }),
      ev(4, 'assistant', { content: '你好呀' }),
      ev(5, 'tool', { name: 'echo', input: { text: 'x' } }),
      ev(6, 'tool', { name: 'echo', input: { text: 'x' }, output: {} }),
      ev(7, 'turn/end', { reason: 'done' }),
    ]
    expect(projectConversation(events)).toEqual([
      { role: 'user', content: '你好', streaming: false },
      { role: 'assistant', content: '你好呀', streaming: false },
    ])
  })

  it('assistant/stream 分片逐条追加到最新 assistant 气泡（streaming=true 标记打字中）', () => {
    const events = [
      ev(2, 'user', { content: '在吗' }),
      ev(3, 'assistant/stream', { content: '你' }),
      ev(4, 'assistant/stream', { content: '好' }),
    ]
    expect(projectConversation(events)).toEqual([
      { role: 'user', content: '在吗', streaming: false },
      { role: 'assistant', content: '你好', streaming: true },
    ])
  })

  it('assistant 终事件封印流式气泡：content 覆盖为全文，streaming=false', () => {
    const events = [
      ev(2, 'user', { content: '在吗' }),
      ev(3, 'assistant/stream', { content: '你' }),
      ev(4, 'assistant', { content: '你好' }),
    ]
    expect(projectConversation(events)).toEqual([
      { role: 'user', content: '在吗', streaming: false },
      { role: 'assistant', content: '你好', streaming: false },
    ])
  })

  it('纯工具请求的 assistant（content 空 + 带 toolCalls）不产生气泡（tool 卡片管它）', () => {
    const events = [
      ev(2, 'user', { content: '回显' }),
      ev(3, 'assistant', { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] }),
      ev(4, 'assistant', { content: '完成' }),
    ]
    expect(projectConversation(events)).toEqual([
      { role: 'user', content: '回显', streaming: false },
      { role: 'assistant', content: '完成', streaming: false },
    ])
  })

  it('历史重放（resume）与非流式实现回退：无分片时 assistant 直接成密封气泡', () => {
    const events = [
      ev(2, 'user', { content: '一' }),
      ev(3, 'assistant', { content: '答一' }),
      ev(4, 'user', { content: '二' }),
      ev(5, 'assistant', { content: '答二' }),
    ]
    expect(projectConversation(events)).toEqual([
      { role: 'user', content: '一', streaming: false },
      { role: 'assistant', content: '答一', streaming: false },
      { role: 'user', content: '二', streaming: false },
      { role: 'assistant', content: '答二', streaming: false },
    ])
  })
})

describe('projectToolCards（M4：tool 调用/结果对投影成卡片）', () => {
  it('调用事件（无 output）→ 待完成卡片；结果事件配对最近同名待完成卡片并填充 output', () => {
    const events = [
      ev(3, 'tool', { name: 'echo', input: { text: '喂' } }),
      ev(4, 'tool', { name: 'echo', input: { text: '喂' }, output: { echoed: '喂' } }),
    ]
    expect(projectToolCards(events)).toEqual([
      { name: 'echo', input: { text: '喂' }, output: { echoed: '喂' }, pending: false },
    ])
  })

  it('调用后尚无结果：pending=true、无 output', () => {
    const events = [ev(3, 'tool', { name: 'read', input: { file_path: 'a.txt' } })]
    expect(projectToolCards(events)).toEqual([
      { name: 'read', input: { file_path: 'a.txt' }, output: undefined, pending: true },
    ])
  })

  it('同名多次调用按顺序配对；孤立结果事件（无前置调用）成独立完整卡片', () => {
    const events = [
      ev(3, 'tool', { name: 'echo', input: { text: '一' } }),
      ev(4, 'tool', { name: 'echo', input: { text: '一' }, output: { echoed: '一' } }),
      ev(5, 'tool', { name: 'echo', input: { text: '二' } }),
      ev(6, 'tool', { name: 'echo', input: { text: '二' }, output: { echoed: '二' } }),
      ev(7, 'tool', { name: 'bash', input: { cmd: 'pwd' }, output: '/home' }),
    ]
    expect(projectToolCards(events)).toEqual([
      { name: 'echo', input: { text: '一' }, output: { echoed: '一' }, pending: false },
      { name: 'echo', input: { text: '二' }, output: { echoed: '二' }, pending: false },
      { name: 'bash', input: { cmd: 'pwd' }, output: '/home', pending: false },
    ])
  })
})
