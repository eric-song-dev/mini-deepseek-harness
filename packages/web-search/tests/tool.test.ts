import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { toolRegistry } from '@mini-dsh/tools'
import { WebError, webRuntime } from '../src/web'
import type { WebSearchProvider, WebSearchResult } from '../src/web'
import { WEB_SEARCH_MAX_RESULTS, webSearchTool } from '../src/tool'

/**
 * webSearchTool 消费方契约（T4）：面向模型的唯一归属方——
 * 声明契约、空 query 报错、**稳定注册**（provider 缺失/不可用时工具仍在，
 * 执行返回 { error } 结果而不是炸掉整轮）、结构化结果原样返回、
 * searchMaxResults/searchTimeoutMs 部署上限、M6 注册可逆。
 */

/** 造 ctx：tools 注册表 + web seam + 消费方工具。 */
async function setup(overrides: { provider?: WebSearchProvider; toolConfig?: object } = {}) {
  const ctx = new Context()
  await ctx.plugin(toolRegistry)
  await ctx.plugin(webRuntime)
  if (overrides.provider) ctx.web.registerSearchProvider(overrides.provider)
  await ctx.plugin(webSearchTool, overrides.toolConfig)
  return ctx
}

function makeProvider(id: string, result: WebSearchResult = { sources: [], truncated: false }) {
  const calls: Array<{ query: string; maxResults?: number }> = []
  const provider: WebSearchProvider = {
    id,
    available: () => true,
    search: async (request) => {
      calls.push({ query: request.query, ...request.maxResults !== undefined ? { maxResults: request.maxResults } : {} })
      return result
    },
  }
  return { provider, calls }
}

const canned: WebSearchResult = {
  content: '答案',
  sources: [{ url: 'https://a.example', title: 'A 站' }],
  truncated: false,
}

describe('webSearchTool 消费方', () => {
  it('声明契约：名/描述/参数 schema 与上游 tool-catalog 同构', async () => {
    const ctx = await setup()
    const [declaration] = ctx.tools.list()
    expect(declaration!.name).toBe('web_search')
    expect(declaration!.description).toContain('Search the web for current information')
    expect(declaration!.description).toContain('cite the relevant URLs as markdown links')
    expect(declaration!.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    })
  })

  it('稳定注册：provider 缺失时工具仍在，执行返回 { error }（不炸轮）', async () => {
    const ctx = await setup()
    expect(ctx.tools.list().map((t) => t.name)).toContain('web_search')
    const output = await ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })
    expect(output).toEqual({ error: '没有可用的搜索提供方' })
  })

  it('空/非字符串 query → { error: query must be a non-empty string }，且不调 seam', async () => {
    const { calls } = makeProvider('fake', canned)
    const ctx = await setup({ provider: { id: 'fake', available: () => true, search: async () => {
      calls.push({ query: 'should-not-reach' })
      return canned
    } } })
    expect(await ctx.tools.execute('web_search', { query: '   ' }, { cwd: '/' })).toEqual({
      error: 'query must be a non-empty string',
    })
    expect(await ctx.tools.execute('web_search', {}, { cwd: '/' })).toEqual({
      error: 'query must be a non-empty string',
    })
    expect(calls).toEqual([])
  })

  it('成功路径：seam 收到 { query, maxResults: 默认 8 }，结构化结果原样返回', async () => {
    const { provider, calls } = makeProvider('fake', canned)
    const ctx = await setup({ provider })
    const output = await ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })
    expect(output).toEqual(canned)
    expect(calls).toEqual([{ query: 'hello', maxResults: WEB_SEARCH_MAX_RESULTS }])
  })

  it('searchMaxResults 配置替换默认上限', async () => {
    const { provider, calls } = makeProvider('fake', canned)
    const ctx = await setup({ provider, toolConfig: { searchMaxResults: 3 } })
    await ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })
    expect(calls).toEqual([{ query: 'hello', maxResults: 3 }])
  })

  it('提供方抛 WebError → { error: message }（稳定注册，不炸轮）', async () => {
    const ctx = await setup({
      provider: {
        id: 'broken',
        available: () => true,
        search: async () => {
          throw new WebError('DeepSeek search request failed: 连接被拒绝', 'WEB_PROVIDER_ERROR')
        },
      },
    })
    const output = await ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })
    expect(output).toEqual({ error: 'DeepSeek search request failed: 连接被拒绝' })
  })

  it('意外错误（非 WebError）上抛——整轮 crash 路径照旧', async () => {
    const ctx = await setup({
      provider: {
        id: 'weird',
        available: () => true,
        search: async () => {
          throw new TypeError('提供方实现 bug')
        },
      },
    })
    await expect(ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })).rejects.toThrow(
      TypeError,
    )
  })

  it('searchTimeoutMs：超时中止合作式提供方 → { error }', async () => {
    const ctx = await setup({
      provider: {
        id: 'slow',
        available: () => true,
        search: (_request, signal) =>
          new Promise<WebSearchResult>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new WebError('slow 被中止', 'WEB_ABORTED')))
          }),
      },
      toolConfig: { searchTimeoutMs: 20 },
    })
    const output = await ctx.tools.execute('web_search', { query: 'hello' }, { cwd: '/' })
    expect(output).toEqual({ error: 'slow 被中止' })
  })

  it('HMR-safety：卸载工具插件 → 工具消失；重装恢复', async () => {
    const ctx = new Context()
    await ctx.plugin(toolRegistry)
    await ctx.plugin(webRuntime)
    const fiber = await ctx.plugin(webSearchTool)
    expect(ctx.tools.list().map((t) => t.name)).toContain('web_search')
    await fiber.dispose()
    expect(ctx.tools.list().map((t) => t.name)).not.toContain('web_search')
    await ctx.plugin(webSearchTool)
    expect(ctx.tools.list().map((t) => t.name)).toContain('web_search')
  })
})
