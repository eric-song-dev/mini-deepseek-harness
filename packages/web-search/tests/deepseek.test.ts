import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { webRuntime } from '../src/web'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
  createDeepseekWebSearch,
  deepseekWebSearch,
} from '../src/deepseek'

/**
 * deepseekWebSearch 真提供方契约（T5）：Anthropic 兼容 Messages API——
 * 请求形状（端点/头/body）、结构化 web_search_tool_result 块映射、
 * 严格模式（无块报错不降级）、错误映射（HTTP/网络/凭据/中止）、
 * available() 本地检查。零 key 零外网：注入假 HTTP 端点（llm adapter 同款模式）。
 */

/** 假 HTTP 端点：记录请求、按脚本返回 Response（脚本耗尽视为网络故障）。 */
function makeFetch() {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const scripted: Array<Response | Error> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    const response = scripted.shift()
    if (response === undefined) throw new TypeError('fetch failed: no scripted response')
    if (response instanceof Error) throw response
    return response
  })
  return { fetchImpl, requests, scripted }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一次带原生搜索结果块的响应（含 text 块 citations 提供 snippet）。 */
function searchResponse() {
  return jsonResponse({
    content: [
      {
        type: 'text',
        text: '根据搜索结果…',
        citations: [
          { url: 'https://a.example', cited_text: 'A 的摘录' },
          { url: 'https://dup.example', cited_text: '重复页摘录' },
        ],
      },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.example', title: 'A 站', page_age: '2026-08-01' },
          { type: 'web_search_result', url: 'https://dup.example', title: '重复页', page_age: '2026-08-01' },
          { type: 'web_search_result', url: 'https://dup.example', title: '重复页第二次出现' },
          { type: 'web_search_result', url: '', title: '空 URL 应被跳过' },
          { type: 'other', url: 'https://x.example' },
          { type: 'web_search_result', url: 'https://b.example' },
        ],
      },
    ],
  })
}

describe('deepseekWebSearch 提供方', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('id 与默认配置常量（上游同款）', () => {
    const provider = createDeepseekWebSearch()
    expect(provider.id).toBe(DEEPSEEK_PROVIDER_ID)
    expect(DEEPSEEK_DEFAULT_BASE_URL).toBe('https://api.deepseek.com/anthropic/v1')
    expect(DEEPSEEK_DEFAULT_MODEL).toBe('deepseek-v4-flash')
    expect(DEEPSEEK_DEFAULT_API_VERSION).toBe('2023-06-01')
    expect(DEEPSEEK_DEFAULT_MAX_TOKENS).toBe(4096)
    expect(DEEPSEEK_DEFAULT_MAX_USES).toBe(5)
  })

  describe('available()：廉价本地检查，禁止网络', () => {
    it('有 key + 合法 baseURL + 正整数上限 → true', () => {
      expect(createDeepseekWebSearch().available()).toBe(true)
    })

    it('无 key → false（含 env 被清空的情形）', () => {
      vi.stubEnv('DEEPSEEK_API_KEY', '')
      expect(createDeepseekWebSearch().available()).toBe(false)
      expect(createDeepseekWebSearch({ apiKey: 'sk-literal' }).available()).toBe(true)
      expect(createDeepseekWebSearch({ apiKeyEnv: 'OTHER_KEY' }).available()).toBe(false)
    })

    it('baseURL 不可解析 → false；maxTokens/maxUses 非正整数 → false', () => {
      expect(createDeepseekWebSearch({ baseURL: 'not a url' }).available()).toBe(false)
      expect(createDeepseekWebSearch({ maxTokens: 0 }).available()).toBe(false)
      expect(createDeepseekWebSearch({ maxUses: -1 }).available()).toBe(false)
    })

    it('不发起任何网络调用', async () => {
      const { fetchImpl } = makeFetch()
      const provider = createDeepseekWebSearch({ fetch: fetchImpl })
      expect(provider.available()).toBe(true)
      await Promise.resolve()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe('请求形状（Anthropic 兼容 Messages API）', () => {
    it('POST {baseURL}/messages + 双鉴权头 + 拒绝重定向 + 原生 web_search 工具', async () => {
      const { fetchImpl, requests, scripted } = makeFetch()
      scripted.push(searchResponse())
      const provider = createDeepseekWebSearch({ fetch: fetchImpl })
      await provider.search({ query: 'mini-deepseek-harness' })
      const { url, init } = requests[0]!
      expect(url).toBe(`${DEEPSEEK_DEFAULT_BASE_URL}/messages`)
      expect(init.method).toBe('POST')
      expect(init.redirect).toBe('error')
      const headers = init.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('sk-test')
      expect(headers.authorization).toBe('Bearer sk-test')
      expect(headers['anthropic-version']).toBe(DEEPSEEK_DEFAULT_API_VERSION)
      expect(headers['content-type']).toBe('application/json')
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({
        model: DEEPSEEK_DEFAULT_MODEL,
        max_tokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: mini-deepseek-harness' }],
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEEPSEEK_DEFAULT_MAX_USES }],
      })
    })

    it('配置字面 apiKey 优先于环境变量；model/maxUses/baseURL 配置生效', async () => {
      const { fetchImpl, requests, scripted } = makeFetch()
      scripted.push(searchResponse())
      const provider = createDeepseekWebSearch({
        apiKey: 'sk-literal',
        baseURL: 'https://gateway.internal/anthropic/v1',
        model: 'custom-model',
        maxUses: 2,
        fetch: fetchImpl,
      })
      await provider.search({ query: 'q' })
      const { url, init } = requests[0]!
      expect(url).toBe('https://gateway.internal/anthropic/v1/messages')
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-literal')
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('custom-model')
      expect(body.tools[0].max_uses).toBe(2)
    })

    it('env DEEPSEEK_SEARCH_BASE_URL 兜底 baseURL（不复用 DEEPSEEK_BASE_URL）', async () => {
      vi.stubEnv('DEEPSEEK_SEARCH_BASE_URL', 'https://search.example/anthropic/v1')
      const { fetchImpl, requests, scripted } = makeFetch()
      scripted.push(searchResponse())
      await createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })
      expect(requests[0]!.url).toBe('https://search.example/anthropic/v1/messages')
    })

    it('调用方 signal 透传给 fetch', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(searchResponse())
      const controller = new AbortController()
      await createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' }, controller.signal)
      expect(fetchImpl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: controller.signal }))
    })
  })

  describe('结果映射（结构化块解析，绝不从模型文本抓 URL）', () => {
    it('web_search_tool_result 块 → sources：url/title/page_age→publishedAt，snippet 按 URL 关联 citations，按 URL 去重，跳过坏条目', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(searchResponse())
      const result = await createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })
      expect(result.content).toBeUndefined() // 提供方答案不受信任
      expect(result.truncated).toBe(false)
      expect(result.sources).toEqual([
        { url: 'https://a.example', title: 'A 站', snippet: 'A 的摘录', publishedAt: '2026-08-01' },
        { url: 'https://dup.example', title: '重复页', snippet: '重复页摘录', publishedAt: '2026-08-01' },
        { url: 'https://b.example' },
      ])
    })

    it('严格模式：无 web_search_tool_result 块 → WEB_PROVIDER_ERROR（不降级文本抓取）', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(jsonResponse({ content: [{ type: 'text', text: '只有文本' }] }))
      await expect(createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      })
    })

    it('citations 首见胜（同 URL 多条只取第一条）', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(jsonResponse({
        content: [
          { type: 'text', citations: [{ url: 'https://a.example', cited_text: '第一条摘录' }] },
          { type: 'text', citations: [{ url: 'https://a.example', cited_text: '第二条摘录' }] },
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A' }] },
        ],
      }))
      const result = await createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })
      expect(result.sources).toEqual([{ url: 'https://a.example', title: 'A', snippet: '第一条摘录' }])
    })
  })

  describe('错误映射', () => {
    it('无 key → WEB_PROVIDER_CREDENTIAL_MISSING（消息含指引）', async () => {
      vi.stubEnv('DEEPSEEK_API_KEY', '')
      await expect(createDeepseekWebSearch().search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      })
      await expect(createDeepseekWebSearch().search({ query: 'q' })).rejects.toThrowError(/DEEPSEEK_API_KEY/)
    })

    it('HTTP 错误：JSON error envelope 的 detail 优先，否则通用文案', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(jsonResponse({ error: { message: '上游说：额度用尽' } }, 429))
      await expect(createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: '上游说：额度用尽',
      })
      const other = makeFetch()
      other.scripted.push(new Response('gateway error', { status: 502 }))
      await expect(createDeepseekWebSearch({ fetch: other.fetchImpl }).search({ query: 'q' })).rejects.toThrowError(
        /DeepSeek API error \(HTTP 502\)/,
      )
    })

    it('网络失败 → DeepSeek search request failed（WEB_PROVIDER_ERROR）', async () => {
      const first = makeFetch()
      first.scripted.push(new TypeError('fetch failed'), new TypeError('fetch failed'))
      const provider = createDeepseekWebSearch({ fetch: first.fetchImpl })
      await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
      })
      await expect(provider.search({ query: 'q' })).rejects.toThrowError(
        /DeepSeek search request failed/,
      )
    })

    it('响应体不可解析 → DeepSeek returned an unprocessable response body', async () => {
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(new Response('not json', { status: 200 }))
      await expect(createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' })).rejects.toThrowError(
        /DeepSeek returned an unprocessable response body/,
      )
    })

    it('调用方取消（预先中止 / fetch 抛 AbortError）→ WEB_ABORTED "DeepSeek search aborted"', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(createDeepseekWebSearch().search({ query: 'q' }, controller.signal)).rejects.toMatchObject({
        code: 'WEB_ABORTED',
        message: 'DeepSeek search aborted',
      })
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(new DOMException('The operation was aborted', 'AbortError'))
      const controller2 = new AbortController()
      await expect(createDeepseekWebSearch({ fetch: fetchImpl }).search({ query: 'q' }, controller2.signal)).rejects.toMatchObject({
        code: 'WEB_ABORTED',
      })
    })
  })

  describe('deepseekWebSearch 插件', () => {
    it('注册进 ctx.web（inject: [web]），经 seam 可搜索', async () => {
      const ctx = new Context()
      await ctx.plugin(webRuntime)
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(searchResponse())
      await ctx.plugin(deepseekWebSearch, { fetch: fetchImpl })
      const result = await ctx.web.search({ query: 'hello' })
      expect(result.sources[0]!.url).toBe('https://a.example')
    })

    it('HMR-safety：卸载插件 → 提供方撤销；重装恢复', async () => {
      const ctx = new Context()
      await ctx.plugin(webRuntime)
      const { fetchImpl, scripted } = makeFetch()
      scripted.push(searchResponse())
      const fiber = await ctx.plugin(deepseekWebSearch, { fetch: fetchImpl })
      await expect(ctx.web.search({ query: 'hello' })).resolves.toBeDefined()
      await fiber.dispose()
      await expect(ctx.web.search({ query: 'hello' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
      scripted.push(searchResponse())
      await ctx.plugin(deepseekWebSearch, { fetch: fetchImpl })
      await expect(ctx.web.search({ query: 'hello' })).resolves.toBeDefined()
    })
  })
})
