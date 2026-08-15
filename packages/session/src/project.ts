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
  for (const event of events) {
    if (event.type === 'user') {
      messages.push({ role: 'user', content: (event.payload as UserEventPayload).content })
    } else if (event.type === 'assistant') {
      const payload = event.payload as AssistantEventPayload
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
  return messages
}
