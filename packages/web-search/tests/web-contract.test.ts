import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { WebError, createWebRuntime, webRuntime } from '../src/web'
import type { WebSearchProvider, WebSearchResult } from '../src/web'

/**
 * web 能力 seam 契约（T2）：上游 ctx.web 的 mini 版——
 * 注册（重 id 报错、disposer 幂等）、执行时选择六支（绝不依赖注册顺序）、
 * maxResults 强制截断、signal 透传、WebError 码表。
 * 断言走行为（选择结果/抛错），不摸内部实现。
 */

/** 可编程假提供方：available 与 search 都可观察/可配置。 */
function makeProvider(id: string, result: WebSearchResult = { sources: [], truncated: false }) {
  const provider = {
    id,
    available: vi.fn(() => true),
    search: vi.fn(async () => result),
  } satisfies WebSearchProvider
  return provider
}

describe('web 能力 seam 契约（ctx.web）', () => {
  it('WebError 携带 code 与消息', () => {
    const error = new WebError('没有可用的搜索提供方', 'WEB_PROVIDER_UNAVAILABLE')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WebError')
    expect(error.message).toBe('没有可用的搜索提供方')
    expect(error.code).toBe('WEB_PROVIDER_UNAVAILABLE')
  })

  describe('registerSearchProvider', () => {
    it('注册后经 search 可见（唯一可用自动选择）', async () => {
      const web = createWebRuntime()
      const provider = makeProvider('fake', { sources: [{ url: 'https://a.example' }], truncated: false })
      web.registerSearchProvider(provider)
      const result = await web.search({ query: 'hello' })
      expect(result.sources).toEqual([{ url: 'https://a.example' }])
      expect(provider.search).toHaveBeenCalledOnce()
    })

    it('重 id 注册抛 WEB_DUPLICATE_PROVIDER', () => {
      const web = createWebRuntime()
      web.registerSearchProvider(makeProvider('fake'))
      expect(() => web.registerSearchProvider(makeProvider('fake'))).toThrowError(
        expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }),
      )
    })

    it('注册不调用 available()（廉价检查只在执行时发生）', () => {
      const web = createWebRuntime()
      const provider = makeProvider('fake')
      web.registerSearchProvider(provider)
      expect(provider.available).not.toHaveBeenCalled()
    })

    it('撤销函数幂等；撤销后选择回到未注册态；可同名重注册', async () => {
      const web = createWebRuntime()
      const provider = makeProvider('fake')
      const off = web.registerSearchProvider(provider)
      off()
      off() // 幂等：重复调用无害
      await expect(web.search({ query: 'hello' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_UNAVAILABLE',
      })
      web.registerSearchProvider(makeProvider('fake'))
      await expect(web.search({ query: 'hello' })).resolves.toBeDefined()
    })
  })

  describe('执行时选择（六支，绝不依赖注册顺序）', () => {
    it('配置 id 已注册且可用 → 用它', async () => {
      const web = createWebRuntime({ searchProvider: 'deepseek-official' })
      const fake = makeProvider('fake')
      const deepseek = makeProvider('deepseek-official')
      // 注册顺序反着来：fake 先注册，但配置 id 必须赢
      web.registerSearchProvider(fake)
      web.registerSearchProvider(deepseek)
      await web.search({ query: 'hello' })
      expect(deepseek.search).toHaveBeenCalledOnce()
      expect(fake.search).not.toHaveBeenCalled()
    })

    it('配置 id 未注册 → WEB_PROVIDER_CONFIGURED_MISSING（消息含 id）', async () => {
      const web = createWebRuntime({ searchProvider: 'ghost' })
      web.registerSearchProvider(makeProvider('fake'))
      await expect(web.search({ query: 'hello' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CONFIGURED_MISSING',
      })
      await expect(web.search({ query: 'hello' })).rejects.toThrowError(/ghost/)
    })

    it('配置 id 已注册但不可用 → WEB_PROVIDER_CONFIGURED_UNAVAILABLE', async () => {
      const web = createWebRuntime({ searchProvider: 'deepseek-official' })
      const deepseek = makeProvider('deepseek-official')
      deepseek.available.mockReturnValue(false)
      web.registerSearchProvider(deepseek)
      web.registerSearchProvider(makeProvider('fake')) // 另一个可用也不能顶替配置 id
      await expect(web.search({ query: 'hello' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
      })
    })

    it('无 id 恰好一个可用 → 自动选择', async () => {
      const web = createWebRuntime()
      const only = makeProvider('only')
      web.registerSearchProvider(only)
      await web.search({ query: 'hello' })
      expect(only.search).toHaveBeenCalledOnce()
    })

    it('无 id 多个可用 → WEB_PROVIDER_AMBIGUOUS（消息含候选 id 集）', async () => {
      const web = createWebRuntime()
      web.registerSearchProvider(makeProvider('alpha'))
      web.registerSearchProvider(makeProvider('beta'))
      await expect(web.search({ query: 'hello' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_AMBIGUOUS',
      })
      await expect(web.search({ query: 'hello' })).rejects.toThrowError(/alpha/)
      await expect(web.search({ query: 'hello' })).rejects.toThrowError(/beta/)
    })

    it('无 id 无可用（含"已注册但不可用"）→ WEB_PROVIDER_UNAVAILABLE', async () => {
      const web = createWebRuntime()
      const broken = makeProvider('broken')
      broken.available.mockReturnValue(false)
      web.registerSearchProvider(broken)
      await expect(web.search({ query: 'hello' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_UNAVAILABLE',
      })
    })
  })

  describe('maxResults 强制（seam 在返回路径执行）', () => {
    const fiveSources: WebSearchResult = {
      content: '答案',
      sources: [1, 2, 3, 4, 5].map((n) => ({ url: `https://s${n}.example` })),
      truncated: false,
    }

    it('提供方超量返回 → 截断 + truncated=true', async () => {
      const web = createWebRuntime()
      web.registerSearchProvider(makeProvider('fake', fiveSources))
      const result = await web.search({ query: 'hello', maxResults: 2 })
      expect(result.sources).toHaveLength(2)
      expect(result.truncated).toBe(true)
      expect(result.content).toBe('答案')
    })

    it('提供方 truncated=true 且未超量 → 保持 true（不篡改提供方事实）', async () => {
      const web = createWebRuntime()
      web.registerSearchProvider(makeProvider('fake', { sources: [{ url: 'https://a.example' }], truncated: true }))
      const result = await web.search({ query: 'hello', maxResults: 8 })
      expect(result.truncated).toBe(true)
    })

    it('未设 maxResults → 原样透传', async () => {
      const web = createWebRuntime()
      web.registerSearchProvider(makeProvider('fake', fiveSources))
      const result = await web.search({ query: 'hello' })
      expect(result.sources).toHaveLength(5)
      expect(result.truncated).toBe(false)
    })
  })

  describe('signal', () => {
    it('透传给选中提供方', async () => {
      const web = createWebRuntime()
      const provider = makeProvider('fake')
      web.registerSearchProvider(provider)
      const signal = new AbortController().signal
      await web.search({ query: 'hello' }, signal)
      expect(provider.search).toHaveBeenCalledWith({ query: 'hello' }, signal)
    })
  })

  describe('webRuntime 插件', () => {
    it('提供 ctx.web 服务', async () => {
      const ctx = new Context()
      await ctx.plugin(webRuntime)
      expect(ctx.web).toBeDefined()
      ctx.web.registerSearchProvider(makeProvider('fake'))
      await expect(ctx.web.search({ query: 'hello' })).resolves.toBeDefined()
    })

    it('config.searchProvider 注入配置 id', async () => {
      const ctx = new Context()
      await ctx.plugin(webRuntime, { searchProvider: 'fake' })
      ctx.web.registerSearchProvider(makeProvider('fake'))
      ctx.web.registerSearchProvider(makeProvider('other'))
      await ctx.web.search({ query: 'hello' })
    })
  })
})
