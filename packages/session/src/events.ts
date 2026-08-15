import 'cordis'
import type { SessionMeta } from './persistence'

// ---- Session 事件词汇（M1）----
// 事件名即日志条目的 type。用 cordis 模块增强把词汇表写进类型系统：
// emit 未声明的事件名、写错载荷，都是编译错误（tests/events.test.ts 的 @ts-expect-error 守护）。
// 运行时事件始终走 cordis 事件总线，类型只是增强（M0 已实证该机制）。
declare module 'cordis' {
  interface Events {
    /** 一轮对话开始。 */
    'turn/start'(): void
    /** 一轮对话结束；reason 标记结束方式（崩溃恢复会补一条 reason: 'crash'）。 */
    'turn/end'(payload: TurnEndPayload): void
    /** 用户消息到达。 */
    'user'(payload: UserEventPayload): void
    /** 助手回复。 */
    'assistant'(payload: AssistantEventPayload): void
    /** 助手流式分片（M4）：assistant 终事件之前的增量文本；分片拼接 == assistant.content。 */
    'assistant/stream'(payload: AssistantStreamPayload): void
    /** 工具调用（M3 起由工具执行管线落事件）。 */
    'tool'(payload: ToolEventPayload): void
    /**
     * 日志追加通知（M4）：会话日志每追加一条条目后同步发出，载荷是刚追加的完整条目。
     * 它本身**不落日志**——host 桥接适配器监听它，把实时事件推给 client。
     */
    'session/append'(event: SessionEvent): void
  }
}

export interface TurnEndPayload {
  /** done=正常结束；user=被用户打断（预留）；crash=异常；limit=工具步数超限（M3）。 */
  reason: 'done' | 'user' | 'crash' | 'limit'
}

export interface UserEventPayload {
  content: string
}

/** 助手流式分片（M4）：一段增量文本。 */
export interface AssistantStreamPayload {
  content: string
}

/** 工具调用（与 llm 包 ToolCall 结构相同；arguments 是已解析对象）。 */
export interface ToolCallPayload {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AssistantEventPayload {
  content: string
  /** 模型请求的工具调用（M3 起：assistant 回复可能是"要工具"，纯文本时无此字段）。 */
  toolCalls?: readonly ToolCallPayload[]
}

export interface ToolEventPayload {
  name: string
  input: unknown
  output?: unknown
}

/** 日志条目类型 = 词汇事件名 + 头记录 'session/created'。 */
export type SessionEventType =
  | 'session/created'
  | 'turn/start'
  | 'turn/end'
  | 'user'
  | 'assistant'
  | 'assistant/stream'
  | 'tool'

/** 日志条目（append-only 日志的存储单元）。 */
export interface SessionEvent {
  /** 会话内单调递增的序号，从 1 开始；1 固定是 session/created 头记录。 */
  seq: number
  /** 事件名（词汇表），即日志条目的 type。 */
  type: SessionEventType
  /** epoch 毫秒时间戳。 */
  ts: number
  /** 事件载荷；由投影（M5）按 type 解释。 */
  payload: unknown
}

/** 可 emit 的词汇事件名：桥接监听器与测试都以这张表为真源。 */
export const SESSION_EVENT_NAMES = ['turn/start', 'turn/end', 'user', 'assistant', 'assistant/stream', 'tool'] as const

/**
 * 每个会话 JSONL 的第一行：session/created 头记录。
 * 它由持久化 create 直接写入（不是 emit 出来的），seq 固定为 1、ts 取 meta.createdAt，
 * 保证"文件首行 == 内存日志首条"这个不变量。
 */
export function createHeaderEvent(meta: SessionMeta): SessionEvent {
  return { seq: 1, type: 'session/created', ts: meta.createdAt, payload: meta }
}
