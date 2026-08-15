import type {
  AssistantEventPayload,
  AssistantStreamPayload,
  SessionEvent,
  ToolEventPayload,
  UserEventPayload,
} from '@mini-dsh/session'

/**
 * 显示投影（M4）：client 侧把事件日志投影成 UI 数据。
 *
 * 与 host 的 projectMessages（模型输入投影）是同一个真源的两个消费者——
 * 这里只读日志、不改日志。assistant/stream 分片是"打字中"的增量，
 * assistant 终事件封印成全文（非流式实现只有终事件，天然兼容）。
 */

/** 一条对话气泡。 */
export interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  /** 是否还在流式追加中（打字机效果；assistant 终事件后封印为 false）。 */
  streaming: boolean
}

/** 一张工具卡片（tool 调用/结果对的投影）。 */
export interface ToolCard {
  name: string
  input: unknown
  output?: unknown
  /** 调用已发出、结果还没回来（渲染"执行中…"）。 */
  pending: boolean
}

/** 日志 → 对话气泡序列（user/assistant/assistant-stream；其余事件跳过）。 */
export function projectConversation(events: readonly SessionEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  for (const event of events) {
    if (event.type === 'user') {
      messages.push({ role: 'user', content: (event.payload as UserEventPayload).content, streaming: false })
    } else if (event.type === 'assistant/stream') {
      const chunk = (event.payload as AssistantStreamPayload).content
      const last = messages.at(-1)
      if (last && last.role === 'assistant') {
        last.content += chunk
        last.streaming = true
      } else {
        messages.push({ role: 'assistant', content: chunk, streaming: true })
      }
    } else if (event.type === 'assistant') {
      const payload = event.payload as AssistantEventPayload
      const last = messages.at(-1)
      if (last && last.role === 'assistant' && last.streaming) {
        // 终事件封印流式气泡：content 覆盖为全文
        if (payload.content !== '') last.content = payload.content
        last.streaming = false
      } else if (payload.content !== '') {
        // 纯工具请求的 assistant（content 空 + toolCalls）不产生气泡，tool 卡片管它
        messages.push({ role: 'assistant', content: payload.content, streaming: false })
      }
    }
  }
  return messages
}

/** 日志 → 工具卡片序列（tool 调用事件开卡、结果事件配对填充）。 */
export function projectToolCards(events: readonly SessionEvent[]): ToolCard[] {
  const cards: ToolCard[] = []
  for (const event of events) {
    if (event.type !== 'tool') continue
    const payload = event.payload as ToolEventPayload
    if (payload.output === undefined) {
      cards.push({ name: payload.name, input: payload.input, pending: true })
      continue
    }
    // 结果事件：配对最近的同名待完成卡片（M3 单步单工具串行，顺序即配对）
    let matched = false
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i]!
      if (card.pending && card.name === payload.name) {
        card.output = payload.output
        card.pending = false
        matched = true
        break
      }
    }
    if (!matched) cards.push({ name: payload.name, input: payload.input, output: payload.output, pending: false })
  }
  return cards
}
