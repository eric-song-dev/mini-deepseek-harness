import 'cordis'

/**
 * LLM seam：agent 与"某个大模型"之间的抽象服务。
 *
 * 教学要点：这是本项目的第二个 seam（继 SessionPersistence 之后）。消费方
 * （agent loop）只认这套契约，不关心背后是 DeepSeek、Ollama 还是假 LLM；
 * 换 provider = 换提供 `llm` 服务的插件，loop 一行不改。
 */

/** 一条模型消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
}

/** chat 的选项。 */
export interface ChatOptions {
  /**
   * 预留（M4 流式 UI）：增量文本回调。
   * M2 的 loop 只消费非流式；M2 的 adapter 与假 LLM 均不调用它。
   */
  onChunk?: (chunk: string) => void
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
