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

/** 消息（与 llm 包 ChatMessage 结构相同）。 */
export interface FakeLlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** usage（与 llm 包 ChatUsage 结构相同）。 */
export interface FakeLlmUsage {
  inputTokens: number
  outputTokens: number
}

/** 一条预设回复。 */
export interface FakeLlmReply {
  /** 预设回复内容。 */
  content: string
  /** 回复前的模拟延迟（毫秒），默认 0。 */
  delay?: number
  /** usage 覆盖；默认 inputTokens=1、outputTokens=1。 */
  usage?: Partial<FakeLlmUsage>
}

/** 一次调用收到的请求（快照）。 */
export interface FakeLlmRequest {
  /** 该次调用收到的 messages（浅拷贝快照）。 */
  messages: readonly FakeLlmMessage[]
}

/** chat 的选项（与 llm 包 ChatOptions 结构相同）。 */
export interface FakeLlmChatOptions {
  /** 预留：M4 流式分片消费；M2 的假 LLM 忽略它。 */
  onChunk?: (chunk: string) => void
}

export interface FakeLlmResult {
  content: string
  usage: FakeLlmUsage
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
    _chatOptions?: FakeLlmChatOptions,
  ): Promise<FakeLlmResult> => {
    // 先记录请求再弹回复：失败的调用（如耗尽）同样可观测。
    requests.push({ messages: [...messages] })
    const reply = queue.shift()
    if (!reply) throw new FakeLlmExhaustedError(requests.length)
    if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay))
    return {
      content: reply.content,
      usage: {
        inputTokens: reply.usage?.inputTokens ?? 1,
        outputTokens: reply.usage?.outputTokens ?? 1,
      },
    }
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
