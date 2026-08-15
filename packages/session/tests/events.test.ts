import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Events } from 'cordis'
import { createEventRecorder, createTestContext } from '@mini-dsh/test-support'
import { createHeaderEvent, SESSION_EVENT_NAMES } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

describe('Session 事件词汇（M1 契约）', () => {
  it('emit 每种词汇事件，recorder 按发生顺序收到且载荷无损', async () => {
    const { ctx, dispose } = await createTestContext()
    const recorder = createEventRecorder(ctx, [...SESSION_EVENT_NAMES])
    try {
      ctx.emit('turn/start')
      ctx.emit('user', { content: '你好' })
      ctx.emit('assistant', { content: '你好呀' })
      ctx.emit('tool', { name: 'bash', input: { cmd: 'pwd' }, output: '/home' })
      ctx.emit('turn/end', { reason: 'done' })

      expect(recorder.events.map((event) => event.name)).toEqual([
        'turn/start', 'user', 'assistant', 'tool', 'turn/end',
      ])
      expect(recorder.eventsOf('user')[0]!.args[0]).toEqual({ content: '你好' })
      expect(recorder.eventsOf('assistant')[0]!.args[0]).toEqual({ content: '你好呀' })
      expect(recorder.eventsOf('tool')[0]!.args[0]).toEqual({
        name: 'bash', input: { cmd: 'pwd' }, output: '/home',
      })
      expect(recorder.eventsOf('turn/end')[0]!.args[0]).toEqual({ reason: 'done' })
      expect(recorder.eventsOf('turn/start')[0]!.args).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('词汇表 SESSION_EVENT_NAMES 覆盖全部可 emit 的事件名', () => {
    expect([...SESSION_EVENT_NAMES].sort()).toEqual(['assistant', 'tool', 'turn/end', 'turn/start', 'user'])
  })

  it('SessionEvent 形状固定为 seq/type/ts/payload（编译期断言）', () => {
    expectTypeOf<SessionEvent>().toMatchTypeOf<{ seq: number, type: string, ts: number, payload: unknown }>()
    expectTypeOf<SessionEvent['type']>().toMatchTypeOf<
      'session/created' | 'turn/start' | 'turn/end' | 'user' | 'assistant' | 'tool'
    >()
  })

  it('createHeaderEvent 生成 session/created 头记录：seq=1，payload 是 meta 本身', () => {
    const meta = { id: 's-1', title: '你好', createdAt: 100 }
    expect(createHeaderEvent(meta)).toEqual({ seq: 1, type: 'session/created', ts: 100, payload: meta })
  })

  it('未声明的词汇事件名是编译错误（@ts-expect-error）', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      // @ts-expect-error 'foo/bar' 不在 Events 词汇表里，emit 拒绝编译
      ctx.emit('foo/bar')
      // @ts-expect-error 'user' 缺少必填载荷，emit 拒绝编译
      ctx.emit('user')
    } finally {
      await dispose()
    }
  })

  it('词汇载荷类型随事件名收窄（编译期断言）', async () => {
    expectTypeOf<Parameters<Events['user']>>().toEqualTypeOf<[{ content: string }]>()
    expectTypeOf<Parameters<Events['assistant']>>().toEqualTypeOf<[{ content: string }]>()
    expectTypeOf<Parameters<Events['turn/end']>>().toEqualTypeOf<[{ reason: 'done' | 'user' | 'crash' }]>()
    expectTypeOf<Parameters<Events['tool']>>().toEqualTypeOf<
      [{ name: string, input: unknown, output?: unknown }]
    >()
    expectTypeOf<Parameters<Events['turn/start']>>().toEqualTypeOf<[]>()
  })
})
