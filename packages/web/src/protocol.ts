import type { SessionEvent } from '@mini-dsh/session'

/**
 * host↔client 桥的消息协议（M4）。
 *
 * client→host 只有一种消息：请求（带 requestId）。
 * host→client 有两种：请求的应答（response，requestId 配对）与会话事件推送（event）。
 * 协议只依赖 @mini-dsh/session 的 SessionEvent——事件日志真源延伸到线上，
 * client 收到的每一条事件就是日志条目本身（seq/ts/payload 原样）。
 */

/** client→host：一次远程调用请求。 */
export interface RequestMessage {
  kind: 'request'
  /** 调用方生成的配对 id；应答原样带回。 */
  requestId: string
  /** RPC 方法名（session.list / session.create / session.resume / session.send 等）。 */
  method: string
  /** 方法参数；由各方法的 handler 解释。 */
  params?: unknown
}

/** 失败应答携带的错误信息。 */
export interface RpcErrorPayload {
  name: string
  message: string
}

/** host→client：请求的应答。 */
export type ResponseMessage =
  | { kind: 'response'; requestId: string; ok: true; result: unknown }
  | { kind: 'response'; requestId: string; ok: false; error: RpcErrorPayload }

/** host→client：会话事件推送（实时通道：词汇事件与 assistant/stream 分片）。 */
export interface EventMessage {
  kind: 'event'
  sessionId: string
  event: SessionEvent
}

/** host→client 的全部消息。 */
export type HostMessage = ResponseMessage | EventMessage
