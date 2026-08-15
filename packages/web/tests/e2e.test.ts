import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { webHost } from '@mini-dsh/web'
import type { EventMessage, HostMessage, ResponseMessage, WebHostHandle } from '@mini-dsh/web'

/**
 * M4 端到端：真 HTTP + 真 WebSocket host（不开真浏览器），脚本化 WS 客户端全链路断言。
 * 浏览器人工验收交给 demo 与教程练习；这里的自动化替身保证同一契约不会悄悄坏掉。
 */

async function makeHost(replies: Parameters<typeof createFakeLlm>[0]['replies']): Promise<{
  handle: WebHostHandle
  dispose: () => Promise<void>
}> {
  const { ctx, dispose } = await createTestContext()
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-e2e-'))
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(provideLlm, createFakeLlm({ replies }))
  await ctx.plugin(toolRegistry)
  ctx.get('tools')!.register({
    declaration: {
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    execute: async (input: Record<string, unknown>) => ({ echoed: input.text }),
  })
  const fiber = await ctx.plugin(webHost, { port: 0, stream: true })
  const handle: WebHostHandle = fiber.ctx['web-host']
  return { handle, dispose }
}

async function connectWs(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const inbox: HostMessage[] = []
  const pending = new Map<string, (message: ResponseMessage) => void>()
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as HostMessage
    if (message.kind === 'response') {
      const resolve = pending.get(message.requestId)
      if (resolve) {
        pending.delete(message.requestId)
        resolve(message)
      }
    }
    inbox.push(message)
  })
  let next = 0
  const request = (method: string, params?: unknown): Promise<ResponseMessage> =>
    new Promise((resolve) => {
      const requestId = `e2e-${++next}`
      pending.set(requestId, resolve)
      socket.send(JSON.stringify({ kind: 'request', requestId, method, params }))
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          resolve({ kind: 'response', requestId, ok: false, error: { name: 'TimeoutError', message: '等待响应超时' } })
        }
      }, 5000)
    })
  return {
    socket,
    inbox,
    request,
    events: (): EventMessage[] => inbox.filter((m): m is EventMessage => m.kind === 'event'),
    close: () => socket.close(),
  }
}

describe('M4 端到端：真 host + 脚本化 WS 客户端', () => {
  it('list → create → send（工具往返 + 流式分片）→ 事件序列完整；断线重连 resume 历史完整再续聊', async () => {
    const host = await makeHost([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
      { chunks: ['收到', '！'] },
      { content: '又见面了' },
    ])
    const client = await connectWs(host.handle.port)
    try {
      // —— 列表：初始为空 ——
      const list = await client.request('session.list')
      expect(list).toMatchObject({ ok: true })
      expect(list.ok && list.result).toEqual([])

      // —— 新建 ——
      const created = await client.request('session.create', { title: 'e2e 会话' })
      expect(created.ok).toBe(true)
      const meta = created.ok ? (created.result as { meta: { id: string } }).meta : undefined
      expect(meta).toMatchObject({ title: 'e2e 会话' })

      // —— 发消息：工具往返 + 流式最终回答 ——
      const send = await client.request('session.send', { id: meta!.id, content: '回显一下' })
      expect(send.ok).toBe(true)
      const events = client.events()
      expect(events.every((m) => m.sessionId === meta!.id)).toBe(true)
      expect(events.map((m) => m.event.type)).toEqual([
        'turn/start',
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant/stream',
        'assistant/stream',
        'assistant',
        'turn/end',
      ])
      // tool 卡片数据（调用 input / 结果 output）与分片载荷逐条无损
      expect(events[1]!.event.payload).toEqual({ content: '回显一下' })
      expect(events[2]!.event.payload).toEqual({
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      expect(events[3]!.event.payload).toEqual({ name: 'echo', input: { text: '喂' } })
      expect(events[4]!.event.payload).toEqual({ name: 'echo', input: { text: '喂' }, output: { echoed: '喂' } })
      expect(events[5]!.event.payload).toEqual({ content: '收到' })
      expect(events[6]!.event.payload).toEqual({ content: '！' })
      expect(events[7]!.event.payload).toEqual({ content: '收到！', usage: { inputTokens: 1, outputTokens: 1 } })

      // —— 断线重连：resume 返回完整历史（含头记录与刚才那一轮）—— 
      client.close()
      const reconnected = await connectWs(host.handle.port)
      const resumed = await reconnected.request('session.resume', { id: meta!.id })
      expect(resumed.ok).toBe(true)
      const payload = resumed.ok
        ? (resumed.result as { events: Array<{ type: string }> })
        : undefined
      expect(payload!.events.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant/stream',
        'assistant/stream',
        'assistant',
        'turn/end',
      ])

      // —— 重连后续聊：新轮次事件只推给新连接 ——
      await reconnected.request('session.send', { id: meta!.id, content: '再来一句' })
      expect(reconnected.events().map((m) => m.event.type)).toEqual([
        'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(reconnected.events()[2]!.event.payload).toEqual({ content: '又见面了', usage: { inputTokens: 1, outputTokens: 1 } })
      reconnected.close()
    } finally {
      client.close()
      await host.dispose()
    }
  }, 30000)
})
