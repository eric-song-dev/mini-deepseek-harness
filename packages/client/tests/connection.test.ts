import { describe, expect, it } from 'vitest'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'
import type { SessionEvent } from '@mini-dsh/session'
import { createBridgeClient, RpcError, wsClientBridge } from '@mini-dsh/client'

/** scripted host：内存直连的桥 + 可编程 handler（client 测试零网络的关键）。 */
function scriptedHost() {
  const [hostSide, clientSide] = memoryConnectionPair()
  const bridge = createRpcBridge()
  bridge.accept(hostSide)
  return {
    bridge,
    clientSide,
    push: (sessionId: string, event: SessionEvent) => bridge.pushEvent(sessionId, event),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('createBridgeClient（client 连接，M4）', () => {
  it('request 按 requestId 配对：并发两个请求各自 resolve 自己的结果', async () => {
    const host = scriptedHost()
    host.bridge.handle('who', (params) => ({ n: (params as { n: number }).n }))
    const client = createBridgeClient(host.clientSide)
    const [a, b] = await Promise.all([client.request('who', { n: 1 }), client.request('who', { n: 2 })])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 2 })
  })

  it('失败应答 reject 成 RpcError：携带服务端错误名与消息（未知方法 / handler 抛错）', async () => {
    const host = scriptedHost()
    host.bridge.handle('boom', () => {
      throw new Error('炸了')
    })
    const client = createBridgeClient(host.clientSide)
    await expect(client.request('boom')).rejects.toBeInstanceOf(RpcError)
    await expect(client.request('boom')).rejects.toMatchObject({ name: 'Error', message: '炸了' })
    await expect(client.request('no-such-method')).rejects.toMatchObject({ name: 'UnknownMethodError' })
  })

  it('onEvent 收到事件推送（sessionId + 完整 SessionEvent），返回取消订阅函数', async () => {
    const host = scriptedHost()
    const client = createBridgeClient(host.clientSide)
    const seen: Array<{ sessionId: string; event: SessionEvent }> = []
    const off = client.onEvent((sessionId, event) => seen.push({ sessionId, event }))
    host.push('s1', { seq: 2, type: 'user', ts: 0, payload: { content: '你好' } })
    await tick()
    expect(seen).toEqual([{ sessionId: 's1', event: { seq: 2, type: 'user', ts: 0, payload: { content: '你好' } } }])
    off()
    host.push('s1', { seq: 3, type: 'assistant', ts: 1, payload: { content: 'x' } })
    await tick()
    expect(seen).toHaveLength(1)
  })

  it('连接关闭后未决请求全部以 ConnectionClosedError reject', async () => {
    const host = scriptedHost()
    host.bridge.handle('hang', () => new Promise(() => {}))
    const client = createBridgeClient(host.clientSide)
    const pending = client.request('hang')
    client.close()
    await expect(pending).rejects.toMatchObject({ name: 'ConnectionClosedError' })
  })
})

describe('wsClientBridge（浏览器侧 WebSocket 包装，M4）', () => {
  /** 假浏览器 WebSocket（构造器 + 可编程触发 open/message/close）。 */
  class FakeWebSocket {
    static sent: string[] = []
    static listeners = new Map<string, Set<(event: unknown) => void>>()

    static fire(type: string, event: unknown) {
      for (const listener of [...(FakeWebSocket.listeners.get(type) ?? [])]) listener(event)
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = FakeWebSocket.listeners.get(type) ?? new Set()
      set.add(listener)
      FakeWebSocket.listeners.set(type, set)
    }

    removeEventListener(type: string, listener: (event: unknown) => void) {
      FakeWebSocket.listeners.get(type)?.delete(listener)
    }

    send(data: string) {
      FakeWebSocket.sent.push(data)
    }

    close() {}
  }

  function makeFakeSocket() {
    FakeWebSocket.sent = []
    FakeWebSocket.listeners = new Map()
    return { socket: FakeWebSocket as unknown as typeof WebSocket, sent: FakeWebSocket.sent }
  }

  it('打开前请求排队、打开后发送；响应与事件到达即配对', async () => {
    const fake = makeFakeSocket()
    const host = scriptedHost()
    host.bridge.handle('echo', (params) => params)
    const client = wsClientBridge({ url: 'ws://fake', webSocket: fake.socket })

    const pending = client.request('echo', { x: 1 })
    expect(fake.sent).toEqual([]) // 未打开：排队
    FakeWebSocket.fire('open', {})
    expect(fake.sent).toEqual([JSON.stringify({ kind: 'request', requestId: 'req-1', method: 'echo', params: { x: 1 } })])

    // 驱动 client 的响应解析（假 socket 不接真 host）
    FakeWebSocket.fire('message', { data: JSON.stringify({ kind: 'response', requestId: 'req-1', ok: true, result: { x: 1 } }) })
    await expect(pending).resolves.toEqual({ x: 1 })

    const events: Array<{ sessionId: string }> = []
    client.onEvent((sessionId) => events.push({ sessionId }))
    FakeWebSocket.fire('message', {
      data: JSON.stringify({ kind: 'event', sessionId: 's1', event: { seq: 2, type: 'user', ts: 0, payload: {} } }),
    })
    await tick()
    expect(events).toEqual([{ sessionId: 's1' }])
  })

  it('连接关闭时未决请求以 ConnectionClosedError reject', async () => {
    const fake = makeFakeSocket()
    const client = wsClientBridge({ url: 'ws://fake', webSocket: fake.socket })
    FakeWebSocket.fire('open', {})
    const pending = client.request('hang')
    FakeWebSocket.fire('close', {})
    await expect(pending).rejects.toMatchObject({ name: 'ConnectionClosedError' })
  })
})
