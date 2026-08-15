import { describe, expect, it } from 'vitest'
import { createTestContext, defineTestService } from '@mini-dsh/test-support'
import type { Context } from 'cordis'

interface Greeting {
  hello: () => string
}

// 用 cordis 模块增强给 ctx 加类型（教学示范：M1 的事件词汇也用同一机制）
declare module 'cordis' {
  interface Context {
    greeting: Greeting
  }
}

describe('defineTestService', () => {
  it('注入的服务能被 ctx.get 取到', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(defineTestService('greeting', { hello: () => 'hi' }))
    const svc = ctx.get('greeting')
    expect(svc).toBeDefined()
    expect(svc.hello()).toBe('hi')
    await dispose()
  })

  it('服务对声明 inject 的插件可见（cordis 原生 DI）', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(defineTestService('greeting', { hello: () => '你好' }))

    const seen: string[] = []
    const consumer = Object.assign((ctx: Context) => {
      seen.push(ctx.greeting.hello())
    }, { inject: ['greeting'] })

    await ctx.plugin(consumer)
    expect(seen).toEqual(['你好'])
    await dispose()
  })
})
