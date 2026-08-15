import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { attachWsBridge, createRpcBridge } from '@mini-dsh/web'
import type { HostMessage, RpcBridge } from '@mini-dsh/web'

/**
 * WS 传输的契约验证：真 WebSocketServer + 真 ws 客户端（本地回环，不开浏览器）。
 * 桥核心的契约在 bridge.test.ts 用内存直连验证，这里验证"生产传输"遵守同一契约。
 */

async function startServer(options: { bridge?: RpcBridge } = {}): Promise<{
  bridge: RpcBridge
  port: number
  close: () => Promise<void>
}> {
  const bridge = options.bridge ?? createRpcBridge()
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  attachWsBridge(bridge, wss)
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  return {
    bridge,
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

async function connectClient(port: number): Promise<{
  socket: WebSocket
  inbox: HostMessage[]
  waitFor: (predicate: (message: HostMessage) => boolean) => Promise<HostMessage>
  close: () => void
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const inbox: HostMessage[] = []
  socket.on('message', (data) => {
    inbox.push(JSON.parse(String(data)) as HostMessage)
  })
  const waitFor = async (predicate: (message: HostMessage) => boolean): Promise<HostMessage> => {
    const deadline = Date.now() + 2000
    for (;;) {
      const found = inbox.find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`等待消息超时，收件箱：${JSON.stringify(inbox)}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return { socket, inbox, waitFor, close: () => socket.close() }
}

describe('attachWsBridge（生产传输：真 WebSocket，M4）', () => {
  it('真 WS 连接走通请求/应答：requestId 配对、result 原样回传', async () => {
    const server = await startServer()
    server.bridge.handle('echo', (params) => ({ got: params }))
    const client = await connectClient(server.port)
    try {
      client.socket.send(JSON.stringify({ kind: 'request', requestId: 'w-1', method: 'echo', params: { x: 1 } }))
      const msg = await client.waitFor((m) => m.kind === 'response' && m.requestId === 'w-1')
      expect(msg).toEqual({ kind: 'response', requestId: 'w-1', ok: true, result: { got: { x: 1 } } })
    } finally {
      client.close()
      await server.close()
    }
  })

  it('事件推送经 WS 到达 client（event 消息带 sessionId 与完整 SessionEvent）', async () => {
    const server = await startServer()
    const client = await connectClient(server.port)
    try {
      server.bridge.pushEvent('s1', { seq: 2, type: 'user', ts: 0, payload: { content: '你好' } })
      const msg = await client.waitFor((m) => m.kind === 'event')
      expect(msg).toEqual({
        kind: 'event',
        sessionId: 's1',
        event: { seq: 2, type: 'user', ts: 0, payload: { content: '你好' } },
      })
    } finally {
      client.close()
      await server.close()
    }
  })

  it('发送无法解析的垃圾 → BadRequestError 应答（requestId unknown），连接仍可用', async () => {
    const server = await startServer()
    server.bridge.handle('echo', () => 'ok')
    const client = await connectClient(server.port)
    try {
      client.socket.send('这不是 JSON')
      const bad = await client.waitFor((m) => m.kind === 'response' && m.ok === false)
      expect(bad).toEqual({
        kind: 'response',
        requestId: 'unknown',
        ok: false,
        error: { name: 'BadRequestError', message: expect.stringContaining('解析') as unknown },
      })
      // 垃圾消息不毒化连接：后续正常请求照常服务
      client.socket.send(JSON.stringify({ kind: 'request', requestId: 'w-2', method: 'echo' }))
      await expect(client.waitFor((m) => m.kind === 'response' && m.requestId === 'w-2')).resolves.toMatchObject({
        ok: true,
        result: 'ok',
      })
    } finally {
      client.close()
      await server.close()
    }
  })

  it('client 断开后桥的连接数下降（断线清理经真 socket 生效）', async () => {
    const server = await startServer()
    const client = await connectClient(server.port)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.bridge.connectionCount).toBe(1)
    client.close()
    // close 事件异步到达桥：轮询到连接数归零
    const deadline = Date.now() + 2000
    while (server.bridge.connectionCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(server.bridge.connectionCount).toBe(0)
    await server.close()
  })
})
