import { describe, expect, it } from 'vitest'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'
import type { HostMessage } from '@mini-dsh/web'
import type { SessionEvent } from '@mini-dsh/session'

/**
 * 脚本化 client：内存直连（同进程零网络）——桥是 seam，测试实现不需要 WebSocket。
 * 生产 transport（ws）在 ws-server.test.ts 里用真连接验证同一契约。
 */
function scriptedClient() {
  const [hostSide, clientSide] = memoryConnectionPair()
  const inbox: HostMessage[] = []
  clientSide.onMessage((message) => inbox.push(message as HostMessage))
  const request = (requestId: string, method: string, params?: unknown): void => {
    clientSide.send({ kind: 'request', requestId, method, params })
  }
  const waitFor = async (predicate: (message: HostMessage) => boolean): Promise<HostMessage> => {
    const deadline = Date.now() + 1000
    for (;;) {
      const found = inbox.find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`等待消息超时，收件箱：${JSON.stringify(inbox)}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  return { hostSide, clientSide, inbox, request, waitFor }
}

function event(type: SessionEvent['type'], seq: number, payload: unknown): SessionEvent {
  return { seq, type, ts: 0, payload }
}

describe('RpcBridge seam（M4：连接管理 + 请求分发 + 事件推送的抽象）', () => {
  it('requestId 配对：请求携带的 requestId 原样随响应返回（同步 handler）', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.handle('echo', (params) => ({ got: params }))
    bridge.accept(client.hostSide)

    client.request('r-1', 'echo', { x: 1 })
    const msg = await client.waitFor((m) => m.kind === 'response' && m.requestId === 'r-1')
    expect(msg).toEqual({ kind: 'response', requestId: 'r-1', ok: true, result: { got: { x: 1 } } })
  })

  it('异步 handler 完成后同样按 requestId 响应，且并发请求互不串号', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.handle('slow', async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return `结果-${(params as { n: number }).n}`
    })
    bridge.accept(client.hostSide)

    client.request('a', 'slow', { n: 1 })
    client.request('b', 'slow', { n: 2 })
    const [a, b] = await Promise.all([
      client.waitFor((m) => m.kind === 'response' && m.requestId === 'a'),
      client.waitFor((m) => m.kind === 'response' && m.requestId === 'b'),
    ])
    expect(a).toMatchObject({ requestId: 'a', ok: true, result: '结果-1' })
    expect(b).toMatchObject({ requestId: 'b', ok: true, result: '结果-2' })
  })

  it('事件推送保序：pushEvent 顺序即 client 收到顺序，且带各自 sessionId', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.accept(client.hostSide)

    bridge.pushEvent('s1', event('user', 2, { content: '一' }))
    bridge.pushEvent('s2', event('assistant', 2, { content: '二' }))
    bridge.pushEvent('s1', event('turn/end', 3, { reason: 'done' }))

    const events = client.inbox.filter((m) => m.kind === 'event')
    expect(events).toEqual([
      { kind: 'event', sessionId: 's1', event: event('user', 2, { content: '一' }) },
      { kind: 'event', sessionId: 's2', event: event('assistant', 2, { content: '二' }) },
      { kind: 'event', sessionId: 's1', event: event('turn/end', 3, { reason: 'done' }) },
    ])
  })

  it('未知方法返回 ok:false + UnknownMethodError，requestId 原样', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.accept(client.hostSide)

    client.request('r-9', 'nope')
    const msg = await client.waitFor((m) => m.kind === 'response' && m.requestId === 'r-9')
    expect(msg).toEqual({
      kind: 'response',
      requestId: 'r-9',
      ok: false,
      error: { name: 'UnknownMethodError', message: expect.stringContaining('nope') as unknown },
    })
  })

  it('handler 抛错返回 ok:false + 原错误名与消息（错误不泄成断线）', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.handle('boom', () => {
      throw new Error('炸了')
    })
    bridge.accept(client.hostSide)

    client.request('r-2', 'boom')
    const msg = await client.waitFor((m) => m.kind === 'response' && m.requestId === 'r-2')
    expect(msg).toEqual({
      kind: 'response',
      requestId: 'r-2',
      ok: false,
      error: { name: 'Error', message: '炸了' },
    })
    // 桥还活着：后续请求照常服务
    bridge.handle('alive', () => 'ok')
    client.request('r-3', 'alive')
    await expect(client.waitFor((m) => m.kind === 'response' && m.requestId === 'r-3')).resolves.toMatchObject({ ok: true })
  })

  it('坏形状消息（非对象 / 缺 requestId / 缺 method / 未知 kind）返回 BadRequestError，桥不崩溃', async () => {
    const bridge = createRpcBridge()
    const client = scriptedClient()
    bridge.accept(client.hostSide)

    client.clientSide.send(42)
    client.clientSide.send({ kind: 'request', method: 'x' })
    client.clientSide.send({ kind: 'request', requestId: 'r-4' })
    client.clientSide.send({ kind: 'unknown' })

    const bad = client.inbox.filter((m) => m.kind === 'response' && m.ok === false)
    expect(bad).toHaveLength(4)
    for (const msg of bad) {
      expect(msg).toMatchObject({ ok: false, error: { name: 'BadRequestError' } })
    }
    // 能识别出 requestId 的坏消息把 requestId 带回，其余用 'unknown'
    expect(bad.map((m) => (m as { requestId: string }).requestId)).toEqual(['unknown', 'unknown', 'r-4', 'unknown'])
    // 桥还活着：正常请求照常服务
    bridge.handle('alive', () => 'ok')
    client.request('r-5', 'alive')
    await expect(client.waitFor((m) => m.kind === 'response' && m.requestId === 'r-5')).resolves.toMatchObject({ ok: true })
  })

  it('重复注册同名方法抛错（防止静默覆盖已有处理器）', () => {
    const bridge = createRpcBridge()
    bridge.handle('dup', () => 'a')
    expect(() => bridge.handle('dup', () => 'b')).toThrow(/已注册/)
  })

  it('断线清理：连接关闭后连接数下降，pushEvent 对已断连接不抛错', async () => {
    const bridge = createRpcBridge()
    const clientA = scriptedClient()
    const clientB = scriptedClient()
    bridge.accept(clientA.hostSide)
    bridge.accept(clientB.hostSide)
    expect(bridge.connectionCount).toBe(2)

    clientA.hostSide.close()
    expect(bridge.connectionCount).toBe(1)

    bridge.pushEvent('s1', event('user', 2, { content: '只到 B' }))
    await clientB.waitFor((m) => m.kind === 'event')
    expect(clientA.inbox.filter((m) => m.kind === 'event')).toHaveLength(0)
  })
})
