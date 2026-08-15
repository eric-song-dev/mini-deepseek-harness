/**
 * 假 LLM（M2）：LLM seam 的"测试实现"。
 *
 * 教学要点：测试环境里的模型调用不能真调 API（慢、花钱、不可复现），
 * 所以假 LLM 是一本"台词本"——按预设顺序弹出回复，并记录每次调用收到的
 * messages（断言"loop 给模型看了什么"的可观测性来源）。
 *
 * 本模块的类型与 `@mini-dsh/llm` 的 seam 结构化相同（不 import 它，避免
 * workspace 循环依赖）；TS 结构化类型让两者可以互相赋值，契约测试里验证。
 */

/** 工具调用（与 llm 包 ToolCall 结构相同；arguments 是已解析对象）。 */
export interface FakeLlmToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** 工具声明（与 llm 包 ToolSpec 结构相同）。 */
export interface FakeLlmToolSpec {
  name: string
  description: string
  /** JSON Schema（OpenAI 兼容 function 参数协议）。 */
  parameters: Record<string, unknown>
}

/** 消息（与 llm 包 ChatMessage 结构相同）。 */
export interface FakeLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息里的工具调用（模型要工具时的输出）。 */
  toolCalls?: readonly FakeLlmToolCall[]
  /** tool 消息归属的工具调用 id（结果回填给哪个调用）。 */
  toolCallId?: string
}

/** usage（与 llm 包 ChatUsage 结构相同）。 */
export interface FakeLlmUsage {
  inputTokens: number
  outputTokens: number
}

/** 一条预设回复。 */
export interface FakeLlmReply {
  /** 预设回复内容；工具调用回复可省略（默认空串）。 */
  content?: string
  /** 预设的工具调用（模型"要工具"时的输出）；与 content 只能二选一有语义。 */
  toolCalls?: readonly FakeLlmToolCall[]
  /** 回复前的模拟延迟（毫秒），默认 0。 */
  delay?: number
  /** usage 覆盖；默认 inputTokens=1、outputTokens=1。 */
  usage?: Partial<FakeLlmUsage>
}

/** 一次调用收到的请求（快照）。 */
export interface FakeLlmRequest {
  /** 该次调用收到的 messages（浅拷贝快照）。 */
  messages: readonly FakeLlmMessage[]
  /** 该次调用收到的工具声明（浅拷贝快照；未传时为空数组）。 */
  tools: readonly FakeLlmToolSpec[]
}

/** chat 的选项（与 llm 包 ChatOptions 结构相同）。 */
export interface FakeLlmChatOptions {
  /** 预留：M4 流式分片消费；M2 的假 LLM 忽略它。 */
  onChunk?: (chunk: string) => void
  /** 可用工具声明（M3 起 loop 传入；假 LLM 只记录不消费）。 */
  tools?: readonly FakeLlmToolSpec[]
}

export interface FakeLlmResult {
  content: string
  usage: FakeLlmUsage
  /** 预设的工具调用（无工具时为 undefined）。 */
  toolCalls?: readonly FakeLlmToolCall[]
}

/** 假 LLM 的公开面（与 llm 包 LLM seam 结构化兼容）。 */
export interface FakeLlm {
  chat(messages: readonly FakeLlmMessage[], options?: FakeLlmChatOptions): Promise<FakeLlmResult>
  /** 全部已记录请求（断言"模型看到了什么"）。 */
  readonly requests: readonly FakeLlmRequest[]
  /** 未弹出的回复数。 */
  readonly remaining: number
}

/** 预设回复耗尽（防止测试在"静默空转"下通过）。 */
export class FakeLlmExhaustedError extends Error {
  constructor(callIndex: number) {
    super(`假 LLM 的预设回复已用尽（第 ${callIndex} 次调用）`)
    this.name = 'FakeLlmExhaustedError'
  }
}

export interface FakeLlmOptions {
  /** 预设回复序列：按调用顺序弹出。 */
  replies: readonly FakeLlmReply[]
}

export function createFakeLlm(options: FakeLlmOptions): FakeLlm {
  const queue = [...options.replies]
  const requests: FakeLlmRequest[] = []

  const chat = async (
    messages: readonly FakeLlmMessage[],
    chatOptions?: FakeLlmChatOptions,
  ): Promise<FakeLlmResult> => {
    // 先记录请求再弹回复：失败的调用（如耗尽）同样可观测。
    requests.push({ messages: [...messages], tools: [...(chatOptions?.tools ?? [])] })
    const reply = queue.shift()
    if (!reply) throw new FakeLlmExhaustedError(requests.length)
    if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay))
    const result: FakeLlmResult = {
      content: reply.content ?? '',
      usage: {
        inputTokens: reply.usage?.inputTokens ?? 1,
        outputTokens: reply.usage?.outputTokens ?? 1,
      },
    }
    if (reply.toolCalls) result.toolCalls = [...reply.toolCalls]
    return result
  }

  return {
    chat,
    get requests() {
      return requests
    },
    get remaining() {
      return queue.length
    },
  }
}
