import { describe, expect, it } from 'vitest'
import { createEventRecorder, createTestContext } from '@mini-dsh/test-support'

// 用 cordis 模块增强声明本测试用到的事件（教学示范：M1 的事件词汇也用同一机制）
declare module 'cordis' {
  interface Events {
    'say'(message: string): void
    'keep'(n: number): void
    'noise'(n: number): void
    'a'(s: string): void
    'b'(s: string): void
  }
}

describe('createEventRecorder', () => {
  it('按发生顺序记录被监听事件的载荷', async () => {
    const { ctx, dispose } = await createTestContext()
    const recorder = createEventRecorder(ctx, ['say'])

    ctx.emit('say', '你好')
    ctx.emit('say', '世界')

    expect(recorder.events).toHaveLength(2)
    expect(recorder.events.map((e) => e.args[0])).toEqual(['你好', '世界'])
    // seq 单调递增，反映全局发生顺序
    expect(recorder.events[0]!.seq).toBeLessThan(recorder.events[1]!.seq)
    await dispose()
  })

  it('只记录指定的事件名', async () => {
    const { ctx, dispose } = await createTestContext()
    const recorder = createEventRecorder(ctx, ['keep'])

    ctx.emit('keep', 1)
    ctx.emit('noise', 2)

    expect(recorder.events.map((e) => e.name)).toEqual(['keep'])
    await dispose()
  })

  it('eventsOf 过滤事件名，last 取最近一条，clear 清空记录', async () => {
    const { ctx, dispose } = await createTestContext()
    const recorder = createEventRecorder(ctx, ['a', 'b'])

    ctx.emit('a', 'x')
    ctx.emit('b', 'y')
    ctx.emit('a', 'z')

    expect(recorder.eventsOf('a').map((e) => e.args[0])).toEqual(['x', 'z'])
    expect(recorder.last('b')!.args[0]).toBe('y')
    expect(recorder.last('a')!.args[0]).toBe('z')

    recorder.clear()
    expect(recorder.events).toHaveLength(0)
    await dispose()
  })
})
