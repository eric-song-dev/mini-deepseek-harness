import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { webRuntime } from '../src/web'
import { FakeWebSearchExhaustedError, createFakeWebSearch, fakeWebSearch } from '../src/fake'
import type { WebSearchResult } from '../src/web'

/**
 * fakeWebSearch 提供方契约（T3）：台词本假提供方——
 * 零 key demo/测试用；台词本按序消费、耗尽抛错（fakellm 同款"防止静默空转"纪律）；
 * 插件经 ctx.effect 挂接注册，卸载即撤销（M6 注册可逆）。
 */

const cannedA: WebSearchResult = {
  content: '答案是 A',
  sources: [{ url: 'https://a.example', title: 'A 站' }],
  truncated: false,
}

const cannedB: WebSearchResult = {
  sources: [{ url: 'https://b.example' }],
  truncated: false,
}

describe('fakeWebSearch 提供方', () => {
  it('id 为 fake，available() 恒 true', () => {
    const provider = createFakeWebSearch()
    expect(provider.id).toBe('fake')
    expect(provider.available()).toBe(true)
  })

  it('无台词本时返回内置固定结果（与 query 无关）', async () => {
    const provider = createFakeWebSearch()
    const first = await provider.search({ query: '任意问题' })
    expect(first.content).toBeDefined()
    expect(first.sources.length).toBeGreaterThan(0)
    expect(first.truncated).toBe(false)
    const second = await provider.search({ query: '另一个问题' })
    expect(second).toEqual(first)
  })

  it('台词本按序消费：两次搜索得到两个预设结果', async () => {
    const provider = createFakeWebSearch([cannedA, cannedB])
    expect(await provider.search({ query: 'q1' })).toEqual(cannedA)
    expect(await provider.search({ query: 'q2' })).toEqual(cannedB)
  })

  it('台词本耗尽抛 FakeWebSearchExhaustedError（防静默空转）', async () => {
    const provider = createFakeWebSearch([cannedA])
    await provider.search({ query: 'q1' })
    const second = provider.search({ query: 'q2' })
    await expect(second).rejects.toBeInstanceOf(FakeWebSearchExhaustedError)
    await expect(second).rejects.toThrowError(/第 2 次/)
  })
})

describe('fakeWebSearch 插件', () => {
  it('注册进 ctx.web，经 seam 唯一自动选择可搜索', async () => {
    const ctx = new Context()
    await ctx.plugin(webRuntime)
    await ctx.plugin(fakeWebSearch, { results: [cannedA] })
    const result = await ctx.web.search({ query: 'hello' })
    expect(result).toEqual(cannedA)
  })

  it('HMR-safety：卸载插件 → 提供方撤销（无可用）；重装恢复', async () => {
    const ctx = new Context()
    await ctx.plugin(webRuntime)
    const fiber = await ctx.plugin(fakeWebSearch, { results: [cannedA] })
    await expect(ctx.web.search({ query: 'hello' })).resolves.toEqual(cannedA)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'hello' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
    })
    await ctx.plugin(fakeWebSearch, { results: [cannedB] })
    await expect(ctx.web.search({ query: 'hello' })).resolves.toEqual(cannedB)
  })
})
