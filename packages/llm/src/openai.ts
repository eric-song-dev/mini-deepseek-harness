import type { Context } from 'cordis'
import type { ChatMessage, ChatOptions, ChatResult, ChatUsage, LLM, ToolCall, ToolSpec } from './llm'

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
  choices?: Array<{
    message?: {
      content?: unknown
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** wire 格式的消息（请求体里的形状；role:tool 的结果消息走 tool_call_id）。 */
type WireMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; tool_calls: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** seam 消息 → wire 消息（协议细节只存在于 adapter：arguments 对象 ↔ JSON 串）。 */
function toWireMessage(message: ChatMessage): WireMessage {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

/** wire tool_calls → seam ToolCall；arguments 是 JSON 串，非法时回退空对象。 */
function parseToolCalls(
  raw: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>,
): ToolCall[] {
  const calls: ToolCall[] = []
  for (const call of raw) {
    const id = typeof call.id === 'string' ? call.id : ''
    const name = typeof call.function?.name === 'string' ? call.function.name : ''
    if (name === '') continue
    const rawArgs = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
    calls.push({ id, name, arguments: parseArguments(rawArgs) })
  }
  return calls
}

/** wire 的 arguments JSON 串 → 已解析对象；非法 JSON 回退空对象。 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    // 非法 JSON：回退空对象（模型输出不可控，别让一次坏参数打崩整个 loop）
  }
  return {}
}

/** SSE data 帧的最小形状（其余字段忽略）。 */
interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown
      tool_calls?: Array<{ index?: number; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 消费 SSE 流式响应（M4）：逐帧回调 onChunk、累积 content、按 index 累积 tool_call 增量、
 * 收尾帧取 usage。分片可能跨网络包边界，按行缓冲再解析。
 */
async function consumeStream(response: Response, onChunk?: (chunk: string) => void): Promise<ChatResult> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('LLM 流式响应缺少 body')
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>()
  let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 }

  const processLine = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    const chunk = JSON.parse(data) as OpenAiStreamChunk
    const delta = chunk.choices?.[0]?.delta
    if (typeof delta?.content === 'string') {
      content += delta.content
      onChunk?.(delta.content)
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0
      const part = toolCallParts.get(index) ?? { id: '', name: '', arguments: '' }
      if (typeof call.id === 'string') part.id = call.id
      if (typeof call.function?.name === 'string') part.name += call.function.name
      if (typeof call.function?.arguments === 'string') part.arguments += call.function.arguments
      toolCallParts.set(index, part)
    }
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      processLine(line)
    }
  }
  buffer += decoder.decode()
  if (buffer !== '') processLine(buffer)

  const toolCalls = [...toolCallParts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, part]) => ({ id: part.id, name: part.name, arguments: parseArguments(part.arguments) }))
    .filter((call) => call.name !== '')

  if (content === '' && toolCalls.length === 0) {
    throw new Error('LLM 流式响应缺少 choices[0].delta.content（既无文本也无工具调用）')
  }
  const result: ChatResult = { content, usage }
  if (toolCalls.length > 0) result.toolCalls = toolCalls
  return result
}

/**
 * 创建 OpenAI 兼容 adapter（返回 LLM 抽象服务）。
 * 请求：POST `<baseUrl>/chat/completions`，body `{ model, messages, stream }`；
 * 响应：`choices[0].message.content` + usage 映射（prompt_tokens→inputTokens 等）。
 * 传 `onChunk`（M4 流式）时 `stream: true` + SSE 逐分片回调；不传时 `stream: false`
 * 与 M2/M3 行为完全一致。
 */
export function createOpenAiLlm(options: OpenAiLlmOptions = {}): LLM {
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = options.model ?? 'deepseek-chat'
  const apiKey = options.apiKey
  const fetchImpl = options.fetch ?? fetch

  return {
    async chat(messages: readonly ChatMessage[], options?: ChatOptions) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const onChunk = options?.onChunk
      const stream = onChunk !== undefined
      const body: Record<string, unknown> = { model, messages: messages.map(toWireMessage), stream }
      if (stream) body.stream_options = { include_usage: true }
      if (options?.tools && options.tools.length > 0) body.tools = toWireTools(options.tools)
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new LlmHttpError(response.status, text.slice(0, 200))
      }
      if (stream) return consumeStream(response, onChunk)
      const text = await response.text()
      const data = JSON.parse(text) as OpenAiResponse
      const message = data.choices?.[0]?.message
      const content = typeof message?.content === 'string' ? message.content : ''
      const toolCalls = message?.tool_calls ? parseToolCalls(message.tool_calls) : undefined
      // 纯文本回复要有 content；工具调用回复 content 可为 null（置空串即可）。
      if (content === '' && (toolCalls === undefined || toolCalls.length === 0)) {
        throw new Error(`LLM 响应缺少 choices[0].message.content：${text.slice(0, 200)}`)
      }
      const result: ChatResult = {
        content,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      }
      if (toolCalls !== undefined && toolCalls.length > 0) result.toolCalls = toolCalls
      return result
    },
  }
}

/** seam 工具声明 → wire 的 tools 字段（type:function 包裹）。 */
function toWireTools(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
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
