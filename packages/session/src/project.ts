import type { AssistantEventPayload, ToolCallPayload, ToolEventPayload, UserEventPayload } from './events'
import type { SessionEvent } from './events'

/** 投影出的工具调用（与 llm 包 ToolCall 结构相同）。 */
export interface ProjectedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** 投影出的模型消息（与 llm 包 ChatMessage 结构相同，loop 直接传给 seam）。 */
export interface ProjectedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息里的工具调用（M3）。 */
  toolCalls?: readonly ProjectedToolCall[]
  /** tool 消息归属的工具调用 id（结果回填给哪个调用）。 */
  toolCallId?: string
}

export interface ProjectMessagesOptions {
  /** system prompt；提供时拼在消息头部（M2 最小组合，工具描述走 ChatOptions.tools 不拼这里）。 */
  systemPrompt?: string
}

/**
 * 把会话日志投影成模型输入的消息数组：user/assistant/tool 事件按日志顺序映射，
 * 其余事件（turn/*、session/created、无结果的 tool 调用）跳过。
 *
 * M3 工具历史映射：assistant 事件的 toolCalls 原样带上；一次工具调用在日志里落两条
 * tool 事件（调用/结果，中间隔着执行），**结果事件**映射成 role:'tool' 消息，其
 * toolCallId 按"最近的 assistant toolCalls 顺序"配对（M3 单步单工具串行，配对即
 * 顺序对应）；没有可配对的孤立结果用合成 id `tool-<seq>`（历史不丢消息）。
 *
 * 悬空调用防护（wire 合法性）：provider 拒绝"assistant 带 tool_calls 但没有紧随的
 * tool 结果"的 transcript。崩溃/limit 可能让日志留下没有结果的声明调用——任何会打断
 * 相邻性的消息（下一轮 user / 下一个 assistant）到来前，或投影结束时，把配对队列里
 * 剩余调用补成 isError 错误结果消息（toolCallId 用原调用 id），保证任何日志投影出的
 * 输入都是合法 transcript。
 *
 * 这是"日志是真源"的输入侧：agent loop 每轮从这里取输入，不另存一份消息数组，
 * resume 后历史（含工具往返）天然完整（M5 的 Trajectory 投影是同一真源的输出侧视图）。
 */
export function projectMessages(
  events: readonly SessionEvent[],
  options: ProjectMessagesOptions = {},
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  let pendingToolCalls: ProjectedToolCall[] = []

  /** 把配对队列里剩余的悬空调用补成 isError 错误结果消息（保 wire 合法）。 */
  const flushPendingAsErrors = (): void => {
    while (pendingToolCalls.length > 0) {
      const call = pendingToolCalls.shift()!
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({ isError: true, content: '工具结果丢失：日志中该调用没有结果记录' }),
      })
    }
  }

  for (const event of events) {
    if (event.type === 'user') {
      // 下一轮用户消息到来前，先闭合上一轮悬空调用（wire 要求 tool 结果紧跟其声明）
      flushPendingAsErrors()
      messages.push({ role: 'user', content: (event.payload as UserEventPayload).content })
    } else if (event.type === 'assistant') {
      const payload = event.payload as AssistantEventPayload
      // 新的 assistant 消息同样会打断 tool 结果与声明的相邻性：先闭合悬空调用
      flushPendingAsErrors()
      const message: ProjectedMessage = { role: 'assistant', content: payload.content }
      if (payload.toolCalls !== undefined && payload.toolCalls.length > 0) {
        message.toolCalls = payload.toolCalls
        pendingToolCalls = [...payload.toolCalls]
      }
      messages.push(message)
    } else if (event.type === 'tool') {
      const payload = event.payload as ToolEventPayload
      // 调用事件（还没有 output）跳过：结果没回来，模型还不能看到它。
      if (payload.output === undefined) continue
      const call: ProjectedToolCall | undefined = pendingToolCalls.shift()
      const toolCallId = call?.id ?? `tool-${event.seq}`
      messages.push({ role: 'tool', toolCallId, content: JSON.stringify(payload.output) })
    }
  }
  // 投影末尾仍有悬空调用（crash/limit 未修复的日志）：补错误结果保 transcript 合法
  flushPendingAsErrors()
  return messages
}
