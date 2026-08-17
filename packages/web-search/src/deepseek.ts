import type { Context } from 'cordis'
import { WebError } from './web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from './web'

/**
 * deepseekWebSearch 真提供方（M10，上游 web-search-deepseek 的 mini 版）。
 *
 * DeepSeek 没有专用搜索端点：每次搜索 = 一次 Anthropic 兼容 Messages API 的完整
 * 模型轮次（POST {baseURL}/messages），启用原生 `web_search_20250305` 服务器工具，
 * 服务端执行搜索并返回**结构化 `web_search_tool_result` 块**——提供方解析块，
 * **绝不从模型文本抓 URL**；无块 → 严格模式抛 WEB_PROVIDER_ERROR（不降级）。
 *
 * 端点注意（上游同款）：搜索走 Anthropic 兼容基址（默认
 * `https://api.deepseek.com/anthropic/v1`），**不复用** `$DEEPSEEK_BASE_URL`——
 * 那是 chat-completions adapter 的基址；只共享 `DEEPSEEK_API_KEY` 凭据。
 * Anthropic wire 格式是提供方私有细节，本提供方不依赖 ctx.llm。
 *
 * mini 裁剪：无 credentials seam（key 直接读 config.apiKey ?? process.env）、
 * 无 settings 层（配置静态，构造时读一次）、无 web/deepseek-search-llm-request
 * 请求日志事件（tool 事件已记调用）、无 recordRequest。
 */

/** 稳定注册 id（上游同款）。 */
export const DEEPSEEK_PROVIDER_ID = 'deepseek-official'

/** 默认端点：Anthropic 兼容基址，`/messages` 由 search() 追加。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** 默认 Anthropic 格式模型名（上游同款）。 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/** 默认 `anthropic-version` 头值。 */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** 默认生成 token 上限。 */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096

/** 默认每请求 `web_search` 服务器工具使用上限。 */
export const DEEPSEEK_DEFAULT_MAX_USES = 5

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * 环境变量命名搜索端点。刻意区别于 `$DEEPSEEK_BASE_URL`（chat-completions 所有）：
 * 搜索说 Anthropic Messages 协议，一个变量无法服务两种端点。
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** 每次请求的自报标识（wire 上可见，不冒充上游）。 */
const USER_AGENT = 'mini-deepseek-harness/0.1.0'

/** deepseekWebSearch 插件配置（profile.yml 插件行 options）。 */
export interface DeepseekWebSearchConfig {
  /** API key 字面值；非空时优先于 apiKeyEnv（上游同款：避免 key 进配置优先用 env）。 */
  apiKey?: string
  /** 环境变量名；默认 DEEPSEEK_API_KEY。 */
  apiKeyEnv?: string
  /** Anthropic 兼容端点基址；缺省走 env DEEPSEEK_SEARCH_BASE_URL，再缺省用默认基址。 */
  baseURL?: string
  /** Anthropic 格式模型名；默认 deepseek-v4-flash。 */
  model?: string
  /** `anthropic-version` 头值；默认 2023-06-01。 */
  apiVersion?: string
  /** Messages 请求生成 token 上限；默认 4096。 */
  maxTokens?: number
  /** 每请求 `web_search` 服务器工具使用上限；默认 5。 */
  maxUses?: number
  /** HTTP 层；默认全局 fetch（测试注入假端点——llm adapter 同款模式）。 */
  fetch?: typeof fetch
}

/** `web_search_tool_result` 块里的结果条目（wire 形状）。 */
interface WireResultItem {
  type?: string
  url?: string
  title?: string | null
  page_age?: string | null
}

/** `web_search_tool_result` 内容块：可引用的结果形状。 */
interface WireToolResultBlock {
  type?: string
  content?: WireResultItem[]
}

/** text 块里的一条引用（snippet 的来源）。 */
interface WireCitation {
  type?: string
  url?: string | null
  cited_text?: string | null
}

/** text 内容块：模型散文 + 按 URL 的引用。 */
interface WireTextBlock {
  type?: string
  text?: string | null
  citations?: WireCitation[]
}

/** 任意内容块；只消费 web_search_tool_result 与 text。 */
type WireBlock = WireToolResultBlock | WireTextBlock | { type?: string }

/** Messages 响应信封（其余字段忽略）。 */
interface WireResponse {
  content?: WireBlock[]
}

/** 错误响应信封（尽力解析，字段因网关而异）。 */
interface WireError {
  error?: { message?: string } | string
  message?: string
}

/**
 * 从所有 text 块的 citations[] 建 `url → cited_text` 映射（snippet 来源）：
 * Anthropic 的 `web_search_result` 条目只带 url/title/page_age，摘录在独立 text
 * 块的 citation 里，按 url 关联（首见胜）。
 */
export function citationSnippets(blocks: readonly WireBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as WireTextBlock).citations ?? []) {
      const url = cite.url
      const text = cite.cited_text
      if (url != null && url.length > 0 && text != null && text.length > 0 && !map.has(url)) {
        map.set(url, text)
      }
    }
  }
  return map
}

/**
 * Messages 响应 → 归一化搜索结果：遍历 `web_search_tool_result` 块取可引用条目，
 * 按 url 关联 citation 摘录为 snippet，按 url 去重（max_uses > 1 的请求可能在多次
 * 搜索里呈现同一页面），空字段省略。`content` 省略——提供方生成答案不受信任。
 * `truncated` 恒 false：maxResults 截断由 seam 在返回路径执行。
 *
 * @throws WebError 无原生搜索块时（严格模式）。
 */
export function mapAnthropicResponse(response: WireResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WireToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      const url = item.url ?? ''
      if (item.type !== 'web_search_result' || url.length === 0 || seen.has(url)) continue
      seen.add(url)
      const snippet = snippets.get(url)
      const source: WebSearchSource = { url }
      if (item.title != null && item.title.length > 0) source.title = item.title
      if (snippet != null && snippet.length > 0) source.snippet = snippet
      if (item.page_age != null && item.page_age.length > 0) source.publishedAt = item.page_age
      sources.push(source)
    }
  }
  return { sources, truncated: false }
}

/** 造一个 DeepSeek 搜索提供方。 */
export function createDeepseekWebSearch(config: DeepseekWebSearchConfig = {}): WebSearchProvider {
  const baseURL = config.baseURL ?? process.env[SEARCH_BASE_URL_ENV] ?? DEEPSEEK_DEFAULT_BASE_URL
  const model = config.model ?? DEEPSEEK_DEFAULT_MODEL
  const apiVersion = config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION
  const maxTokens = config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS
  const maxUses = config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const fetchImpl = config.fetch ?? fetch

  /** 同步解析本次搜索的 key：字面值优先，否则读环境变量。 */
  const resolveApiKey = (): string | undefined => {
    if (config.apiKey !== undefined && config.apiKey.length > 0) return config.apiKey
    const ambient = process.env[apiKeyEnv]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  return {
    id: DEEPSEEK_PROVIDER_ID,

    available(): boolean {
      // 廉价本地检查：凭据 + 端点可解析 + 上限为正整数。禁止网络调用。
      return resolveApiKey() !== undefined
        && URL.canParse(baseURL)
        && isPositiveInteger(maxTokens)
        && isPositiveInteger(maxUses)
    },

    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      if (isAborted(signal)) throw searchAborted(signal)
      const apiKey = resolveApiKey()
      if (apiKey === undefined) {
        throw new WebError(
          `DeepSeek search has no API key for "${apiKeyEnv}"; export it in the launching environment, `
          + 'or set a literal "apiKey" in the web-search-deepseek config',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      const endpoint = `${baseURL}/messages`
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      }

      let response: Response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            // 官方 DeepSeek 期望 x-api-key；Anthropic 兼容代理可能期望 Bearer——两者都发。
            'x-api-key': apiKey,
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': apiVersion,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          ...signal !== undefined ? { signal } : {},
        })
      } catch (error) {
        if (isAborted(signal) || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(`DeepSeek search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (!response.ok) {
        const status = response.status
        let message = `DeepSeek API error (HTTP ${status})`
        try {
          const parsed = (await response.json()) as WireError
          const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
          if (detail !== undefined && detail.length > 0) message = detail
        } catch (error) {
          // 中止发生在读错误体途中 → 按取消报告，不吞成通用 HTTP 错误（取消不是提供方故障）。
          if (isAborted(signal) || isAbortError(error)) throw searchAborted(signal, error)
          // 否则：状态码已入 message；畸形错误体（网关 5xx/429 常见）只损失更丰富的文案。
        }
        throw new WebError(message, 'WEB_PROVIDER_ERROR')
      }

      try {
        const payload = (await response.json()) as WireResponse
        return mapAnthropicResponse(payload)
      } catch (error) {
        if (isAborted(signal) || isAbortError(error)) throw searchAborted(signal, error)
        if (error instanceof WebError) throw error
        throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
          cause: error,
        })
      }
    },
  }
}

/** 构建提供方的稳定取消错误（保留调用方原因）。 */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DeepSeek search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** 调用方是否已中止（函数调用避免 TS 对同一属性检查的窄化误报）。 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** 是否为 fetch/AbortSignal 的中止错误。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 可发给 Messages API 的正整数上限检查。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * 插件：把 DeepSeek 搜索提供方注册进 ctx.web（inject: ['web']）。
 * 提供方注册的是**能力**而非工具——不注册任何面向模型的工具（归消费方所有）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销。
 */
export const deepseekWebSearch = Object.assign(
  function deepseekWebSearch(ctx: Context, config: DeepseekWebSearchConfig = {}): void {
    const off = ctx.web.registerSearchProvider(createDeepseekWebSearch(config))
    ctx.effect(() => () => off())
  },
  { inject: ['web'] },
)
