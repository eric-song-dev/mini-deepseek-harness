import type { SessionEvent } from './events'
import type { AssistantEventPayload, UserEventPayload } from './events'

/** 投影出的模型消息（与 llm 包 ChatMessage 结构相同，loop 直接传给 seam）。 */
export interface ProjectedMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ProjectMessagesOptions {
  /** system prompt；提供时拼在消息头部（M2 最小组合，工具描述注入是 M3 的事）。 */
  systemPrompt?: string
}

/**
 * 把会话日志投影成模型输入的消息数组：user/assistant 事件按日志顺序映射，
 * 其余事件（turn/*、tool、session/created）全部跳过。
 *
 * 这是"日志是真源"的输入侧：agent loop 每轮从这里取输入，不另存一份消息数组，
 * resume 后历史天然完整（M5 的 Trajectory 投影是同一真源的输出侧视图）。
 */
export function projectMessages(
  events: readonly SessionEvent[],
  options: ProjectMessagesOptions = {},
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  for (const event of events) {
    if (event.type === 'user') {
      messages.push({ role: 'user', content: (event.payload as UserEventPayload).content })
    } else if (event.type === 'assistant') {
      messages.push({ role: 'assistant', content: (event.payload as AssistantEventPayload).content })
    }
  }
  return messages
}
