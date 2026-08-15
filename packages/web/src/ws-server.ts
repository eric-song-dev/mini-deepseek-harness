import { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { BridgeConnection, RpcBridge } from './bridge'

/**
 * 桥的生产传输：把 WebSocketServer 的每条连接包装成 BridgeConnection 喂给桥。
 *
 * 教学要点：桥（bridge.ts）完全不知道 WebSocket 的存在——传输层只负责
 * "JSON 文本 ↔ 消息对象"与连接生命周期，请求分发/配对/事件推送全在桥里。
 * 无法解析的消息以 `{ kind: 'bad-message' }` 标记交给桥应答错误（不断线）。
 */
export function attachWsBridge(bridge: RpcBridge, wss: WebSocketServer): void {
  wss.on('connection', (socket) => {
    let open = true
    const conn: BridgeConnection = {
      send(message) {
        if (!open) return
        socket.send(JSON.stringify(message))
      },
      onMessage(handler) {
        const listener = (data: RawData) => {
          try {
            handler(JSON.parse(String(data)) as unknown)
          } catch {
            // 无法解析：以标记消息交给桥，桥应答 BadRequestError 而不是崩掉连接
            handler({ kind: 'bad-message' })
          }
        }
        socket.on('message', listener)
        return () => {
          socket.off('message', listener)
        }
      },
      onClose(handler) {
        const listener = () => handler()
        socket.on('close', listener)
        return () => {
          socket.off('close', listener)
        }
      },
      close() {
        open = false
        socket.close()
      },
    }
    bridge.accept(conn)
  })
}
