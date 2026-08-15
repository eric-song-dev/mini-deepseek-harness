import type { SessionEvent } from '@mini-dsh/session'

/**
 * Client 连接 seam（M4）：UI 插件只认"可注入的 client 连接"，不认 WebSocket。
 *
 * 与 host 侧 RpcBridge 是同一桥的两端：这里只有"发请求 + 收事件"。
 * 生产实现 wsClientBridge 包浏览器 WebSocket；测试实现直接接内存直连的
 * connection（createBridgeClient + memoryConnectionPair，同进程零网络）。
 * 协议形状与 @mini-dsh/web 的桥协议结构化相同（本包不 import web，避免
 * client→web 的运行时依赖——与 fakellm 不 import llm 同款手法）。
 */

/** transport 无关的最小连接形态（内存直连与浏览器 WebSocket 都实现它）。 */
export interface ClientTransport {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

/** 服务端错误在 client 侧的形态（RPC 失败应答 reject 成它）。 */
export class RpcError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** client 连接：请求（requestId 自动生成）与事件订阅。 */
export interface ClientBridge {
  /** 发起一次 RPC 请求；失败（服务端错误/断线）以 RpcError reject。 */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  /** 订阅会话事件推送；返回取消订阅函数。 */
  onEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void
  /** 关闭连接（未决请求全部 reject）。 */
  close(): void
}

interface Incoming {
  kind?: unknown
  requestId?: unknown
  ok?: unknown
  result?: unknown
  error?: { name?: unknown; message?: unknown }
  sessionId?: unknown
  event?: unknown
}

/** 把任意 transport 包装成 ClientBridge：requestId 配对、错误转 RpcError、事件分发。 */
export function createBridgeClient(transport: ClientTransport): ClientBridge {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const eventHandlers = new Set<(sessionId: string, event: SessionEvent) => void>()
  let nextId = 0

  transport.onMessage((message) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as Incoming
    if (msg.kind === 'response') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
      if (requestId === undefined) return
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      if (msg.ok === true) {
        entry.resolve(msg.result)
      } else {
        const name = typeof msg.error?.name === 'string' ? msg.error.name : 'Error'
        const text = typeof msg.error?.message === 'string' ? msg.error.message : 'RPC 调用失败'
        entry.reject(new RpcError(name, text))
      }
    } else if (msg.kind === 'event' && typeof msg.sessionId === 'string' && msg.event !== undefined) {
      for (const handler of [...eventHandlers]) handler(msg.sessionId, msg.event as SessionEvent)
    }
  })

  transport.onClose(() => {
    for (const { reject } of pending.values()) reject(new RpcError('ConnectionClosedError', '连接已断开'))
    pending.clear()
  })

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const requestId = `req-${++nextId}`
        pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
        transport.send({ kind: 'request', requestId, method, params })
      })
    },
    onEvent(handler) {
      eventHandlers.add(handler)
      return () => {
        eventHandlers.delete(handler)
      }
    },
    close() {
      transport.close()
    },
  }
}

export interface WsClientOptions {
  /** 连接地址（ws://…）。 */
  url: string
  /** WebSocket 构造器；默认浏览器的全局 WebSocket（测试注入假实现）。 */
  webSocket?: typeof WebSocket
}

/** 生产连接：包一个浏览器 WebSocket。打开前的请求排队，打开后 flush。 */
export function wsClientBridge(options: WsClientOptions): ClientBridge {
  const WebSocketImpl = options.webSocket ?? globalThis.WebSocket
  const socket = new WebSocketImpl(options.url)
  const queue: unknown[] = []
  let open = false
  socket.addEventListener('open', () => {
    open = true
    for (const message of queue) socket.send(JSON.stringify(message))
    queue.length = 0
  })
  const transport: ClientTransport = {
    send(message) {
      if (open) socket.send(JSON.stringify(message))
      else queue.push(message)
    },
    onMessage(handler) {
      const listener = (event: MessageEvent) => {
        try {
          handler(JSON.parse(String(event.data)) as unknown)
        } catch {
          // 无法解析的推送：忽略（host 侧不会发出坏消息）
        }
      }
      socket.addEventListener('message', listener)
      return () => {
        socket.removeEventListener('message', listener)
      }
    },
    onClose(handler) {
      const listener = () => handler()
      socket.addEventListener('close', listener)
      return () => {
        socket.removeEventListener('close', listener)
      }
    },
    close() {
      socket.close()
    },
  }
  return createBridgeClient(transport)
}
