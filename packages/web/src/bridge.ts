import type { SessionEvent } from '@mini-dsh/session'
import type { ResponseMessage } from './protocol'

/**
 * RpcBridge seam（M4）：host 侧"连接管理 + 请求分发 + 事件推送"的抽象。
 *
 * 教学要点：UI 与 host 逻辑都只认这套契约，不认 WebSocket。生产实现是 ws 传输
 * （ws-server.ts 的 attachWsBridge），测试实现是内存直连（memoryConnectionPair，
 * 同进程零网络）——换传输层，桥、RPC handler、client 一行不改。
 */

/** 一条 client 连接（transport 无关的最小形态）。 */
export interface BridgeConnection {
  /** 向该连接发一条消息（已断连接静默丢弃）。 */
  send(message: unknown): void
  /** 收到一条消息；返回取消订阅函数。 */
  onMessage(handler: (message: unknown) => void): () => void
  /** 连接关闭；返回取消订阅函数。 */
  onClose(handler: () => void): () => void
  /** 主动关闭连接。 */
  close(): void
}

/** 一个 RPC 方法处理器：入参是请求的 params，返回值（或 Promise）是应答的 result。 */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>

/** 桥的公开面（webHost 提供为 `rpc-bridge` 服务）。 */
export interface RpcBridge {
  /** 注册一个 RPC 方法；同名重复注册抛错（防止静默覆盖）。 */
  handle(method: string, handler: RpcHandler): void
  /** 把一条会话事件推给全部已连接的 client（按推送顺序到达）。 */
  pushEvent(sessionId: string, event: SessionEvent): void
  /** 接收一条新连接（transport 侧调用）。 */
  accept(conn: BridgeConnection): void
  /** 当前连接数（测试与观测用）。 */
  readonly connectionCount: number
}

function bad(requestId: string, name: string, message: string): ResponseMessage {
  return { kind: 'response', requestId, ok: false, error: { name, message } }
}

/** 创建一个空桥：注册方法 → accept 连接 → 分发请求 / 推送事件。 */
export function createRpcBridge(): RpcBridge {
  const handlers = new Map<string, RpcHandler>()
  const connections = new Set<BridgeConnection>()

  const respond = (conn: BridgeConnection, response: ResponseMessage): void => {
    // 连接已断：不再投递（清理交给 onClose）
    if (!connections.has(conn)) return
    try {
      conn.send(response)
    } catch {
      // transport 层失败（如写半断连接）：忽略，清理交给 onClose
    }
  }

  const dispatch = (conn: BridgeConnection, message: unknown): void => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      respond(conn, bad('unknown', 'BadRequestError', '消息必须是对象'))
      return
    }
    const raw = message as { kind?: unknown; requestId?: unknown; method?: unknown; params?: unknown }
    if (raw.kind !== 'request') {
      respond(conn, bad('unknown', 'BadRequestError', `未知消息类型：${String(raw.kind)}`))
      return
    }
    const requestId = typeof raw.requestId === 'string' ? raw.requestId : undefined
    const method = typeof raw.method === 'string' ? raw.method : undefined
    if (requestId === undefined || method === undefined) {
      respond(conn, bad(requestId ?? 'unknown', 'BadRequestError', 'request 缺 requestId 或 method'))
      return
    }
    const handler = handlers.get(method)
    if (!handler) {
      respond(conn, {
        kind: 'response',
        requestId,
        ok: false,
        error: { name: 'UnknownMethodError', message: `未知 RPC 方法：${method}` },
      })
      return
    }
    // handler 同步抛错 / 异步 rejection 统一转成失败应答，不让一次坏调用打崩桥
    Promise.resolve()
      .then(() => handler(raw.params))
      .then(
        (result) => respond(conn, { kind: 'response', requestId, ok: true, result }),
        (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error))
          respond(conn, { kind: 'response', requestId, ok: false, error: { name: err.name, message: err.message } })
        },
      )
  }

  return {
    handle(method, handler) {
      if (handlers.has(method)) throw new Error(`RPC 方法已注册：${method}`)
      handlers.set(method, handler)
    },
    pushEvent(sessionId, event) {
      for (const conn of connections) {
        try {
          conn.send({ kind: 'event', sessionId, event })
        } catch {
          // 已断连接：忽略，清理交给 onClose
        }
      }
    },
    accept(conn) {
      if (connections.has(conn)) return
      connections.add(conn)
      conn.onMessage((message) => dispatch(conn, message))
      conn.onClose(() => {
        connections.delete(conn)
      })
    },
    get connectionCount() {
      return connections.size
    },
  }
}

/**
 * 内存直连：造一对已连接的 BridgeConnection（同进程零网络）。
 * 返回 [host 侧, client 侧]——host 侧给 bridge.accept，client 侧给 client 包/测试脚本。
 * 这是桥 seam 的测试传输：client 组件测试零网络可跑的关键。
 */
export function memoryConnectionPair(): [BridgeConnection, BridgeConnection] {
  const leftInbox = new Set<(message: unknown) => void>()
  const rightInbox = new Set<(message: unknown) => void>()
  const leftCloseHandlers = new Set<() => void>()
  const rightCloseHandlers = new Set<() => void>()
  let leftOpen = true
  let rightOpen = true

  const left: BridgeConnection = {
    send(message) {
      if (!rightOpen) return
      for (const handler of [...rightInbox]) handler(message)
    },
    onMessage(handler) {
      leftInbox.add(handler)
      return () => {
        leftInbox.delete(handler)
      }
    },
    onClose(handler) {
      leftCloseHandlers.add(handler)
      return () => {
        leftCloseHandlers.delete(handler)
      }
    },
    close() {
      if (!leftOpen) return
      leftOpen = false
      rightOpen = false
      for (const handler of [...leftCloseHandlers]) handler()
      for (const handler of [...rightCloseHandlers]) handler()
    },
  }
  const right: BridgeConnection = {
    send(message) {
      if (!leftOpen) return
      for (const handler of [...leftInbox]) handler(message)
    },
    onMessage(handler) {
      rightInbox.add(handler)
      return () => {
        rightInbox.delete(handler)
      }
    },
    onClose(handler) {
      rightCloseHandlers.add(handler)
      return () => {
        rightCloseHandlers.delete(handler)
      }
    },
    close() {
      if (!rightOpen) return
      rightOpen = false
      leftOpen = false
      for (const handler of [...rightCloseHandlers]) handler()
      for (const handler of [...leftCloseHandlers]) handler()
    },
  }
  return [left, right]
}
