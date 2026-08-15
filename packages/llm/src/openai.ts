import type { Context } from 'cordis'
import type { ChatMessage, LLM } from './llm'

/**
 * OpenAI 兼容 adapter：LLM seam 的第一个（也是生产环境唯一）实现。
 *
 * DeepSeek API 的 `/chat/completions` 就是 OpenAI 兼容协议，因此这一个 adapter
 * 覆盖 DeepSeek 官方 API、Ollama、vLLM 等所有兼容端点——换模型只换插件配置，
 * 不换 loop（seam 的意义，requirements §4）。
 *
 * HTTP 层可注入（fetch）：测试注入假端点，零 key 不真调 API。
 */
export interface OpenAiLlmOptions {
  /** API 端点 base URL；默认 `https://api.deepseek.com`（会自动补 `/chat/completions`）。 */
  baseUrl?: string
  /** API key；提供时带 `Authorization: Bearer` 头。Ollama/vLLM 等本地端点无需 key，留空即可。 */
  apiKey?: string
  /** 模型名；默认 `deepseek-chat`。 */
  model?: string
  /** HTTP 层；默认全局 fetch（测试注入假端点）。 */
  fetch?: typeof fetch
}

/** 非 2xx 响应（携带状态码与响应片段）。 */
export class LlmHttpError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`LLM HTTP ${status}: ${detail}`)
    this.name = 'LlmHttpError'
    this.status = status
  }
}

/** OpenAI 兼容响应的最小形状（其余字段忽略）。 */
interface OpenAiResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 创建 OpenAI 兼容 adapter（返回 LLM 抽象服务）。
 * 请求：POST `<baseUrl>/chat/completions`，body `{ model, messages, stream: false }`；
 * 响应：`choices[0].message.content` + usage 映射（prompt_tokens→inputTokens 等）。
 * M2 只消费非流式：`stream: false` 写死，`onChunk` 选项预留不调用（M4 接 UI）。
 */
export function createOpenAiLlm(options: OpenAiLlmOptions = {}): LLM {
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = options.model ?? 'deepseek-chat'
  const apiKey = options.apiKey
  const fetchImpl = options.fetch ?? fetch

  return {
    async chat(messages: readonly ChatMessage[]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, stream: false }),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new LlmHttpError(response.status, text.slice(0, 200))
      }
      const data = JSON.parse(text) as OpenAiResponse
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error(`LLM 响应缺少 choices[0].message.content：${text.slice(0, 200)}`)
      }
      return {
        content,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}

/**
 * adapter 插件：把 OpenAI 兼容 adapter 注册成 `llm` 服务。
 * 换 provider = 换提供服务的插件（JSONL 后端同款注入模式）。
 */
export function openAiLlm(ctx: Context, options: OpenAiLlmOptions): void {
  ctx.provide('llm', createOpenAiLlm(options))
}

/**
 * 通用注入插件：把任意 LLM 实例注册成 `llm` 服务。
 * demo 与测试用它注入假 LLM——"连假模型也是一个插件"。
 */
export function provideLlm(ctx: Context, llm: LLM): void {
  ctx.provide('llm', llm)
}
