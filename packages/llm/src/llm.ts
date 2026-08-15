import 'cordis'

/**
 * LLM seam：agent 与"某个大模型"之间的抽象服务。
 *
 * 教学要点：这是本项目的第二个 seam（继 SessionPersistence 之后）。消费方
 * （agent loop）只认这套契约，不关心背后是 DeepSeek、Ollama 还是假 LLM；
 * 换 provider = 换提供 `llm` 服务的插件，loop 一行不改。
 */

/** 一次工具调用（模型"要工具"时的输出）。 */
export interface ToolCall {
  /** 调用 id：结果消息用它回填到具体调用（OpenAI 协议的 tool_call_id）。 */
  id: string
  name: string
  /** 已解析的参数对象；adapter 负责 wire 格式的 JSON 串 ↔ 对象的转换。 */
  arguments: Record<string, unknown>
}

/** 工具声明（模型可读的"我能干什么"；与 tools 包 ToolDeclaration 结构相同）。 */
export interface ToolSpec {
  name: string
  description: string
  /** 参数 JSON Schema（OpenAI 兼容 function 协议原生格式）。 */
  parameters: Record<string, unknown>
}

/** 一条模型消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息里的工具调用（模型要工具时的输出）。 */
  toolCalls?: readonly ToolCall[]
  /** tool 消息归属的工具调用 id（结果回填给哪个调用）。 */
  toolCallId?: string
}

/** 单次调用的 token 用量。 */
export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

/** 单次 chat 的结果。 */
export interface ChatResult {
  content: string
  usage: ChatUsage
  /** 模型请求的工具调用；纯文本回复时为 undefined。 */
  toolCalls?: readonly ToolCall[]
}

/** chat 的选项。 */
export interface ChatOptions {
  /**
   * 流式增量回调（M4 起被消费）：每收到一个文本分片回调一次。
   * adapter 传入时切换 stream:true + SSE 逐帧解析；假 LLM 按 chunks 台词逐片回调。
   * 不传 = 非流式，行为与 M2/M3 完全一致。
   */
  onChunk?: (chunk: string) => void
  /** 可用工具声明（M3 起 loop 从 tools seam 取声明列表传入）。 */
  tools?: readonly ToolSpec[]
}

/** LLM 抽象服务。 */
export interface LLM {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>
}

// 服务类型增强：插件可通过 `ctx.llm` / `ctx.get('llm')` 取到 seam（M1 同款模式）。
declare module 'cordis' {
  interface Context {
    llm: LLM
  }
}
