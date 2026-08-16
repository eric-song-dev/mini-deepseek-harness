import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { projectTurns } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'
import type { EventMessage, HostMessage, ResponseMessage } from '@mini-dsh/web'
import { createWebDemoRuntime } from '../examples/web-demo-shared'
import type { WebDemoRuntime } from '../examples/web-demo-shared'

/**
 * demo:web:real 冒烟测试（post-MVP 增补）：
 * 同一个 web demo runtime（web-demo-shared）换 llm:'real'（OpenAI 兼容 adapter），
 * baseUrl 指向**本地真 HTTP 假端点**（SSE 流式）——零 key、零外网，但走的是
 * adapter 的真实 HTTP + SSE 链路（fetch 不注入）。
 * 断言三件事：
 * 1. 真 HTTP 调用发生：URL /chat/completions、Bearer key、system prompt 带当前日期；
 * 2. 流式分片 + 终事件 + usage 全部落日志（M4/M5 链路对真 adapter 成立）；
 * 3. projectTurns 能投影出这一轮（轨迹对真对话成立）。
 */

// ---- 假 OpenAI 兼容端点（本地真 HTTP + SSE）----
interface CapturedRequest {
  url: string | undefined
  authorization: string | undefined
  body: Record<string, unknown>
}

function startStubEndpoint(): Promise<{
  port: number
  requests: CapturedRequest[]
  close: () => Promise<void>
}> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = [
        { choices: [{ delta: { content: '今年是' } }] },
        { choices: [{ delta: { content: '2026年' } }] },
        { choices: [{ delta: { content: '。' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
      ]
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      resolveListen({
        port,
        requests,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}

// ---- 脚本化 client（host.test.ts 同款：内存直连 + requestId 配对）----
function scriptedClient() {
  const [hostSide, clientSide] = memoryConnectionPair()
  const inbox: HostMessage[] = []
  const pending = new Map<string, (message: ResponseMessage) => void>()
  clientSide.onMessage((message) => {
    const msg = message as HostMessage
    if (msg.kind === 'response') {
      const resolve = pending.get(msg.requestId)
      if (resolve) {
        pending.delete(msg.requestId)
        resolve(msg)
      }
    }
    inbox.push(msg)
  })
  let nextId = 0
  const request = (method: string, params?: unknown): Promise<ResponseMessage> =>
    new Promise((resolve) => {
      const requestId = `c-${++nextId}`
      pending.set(requestId, resolve)
      clientSide.send({ kind: 'request', requestId, method, params })
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          resolve({ kind: 'response', requestId, ok: false, error: { name: 'TimeoutError', message: '等待响应超时' } })
        }
      }, 3000)
    })
  return { hostSide, request, close: () => clientSide.close() }
}

async function okResult(response: ResponseMessage): Promise<unknown> {
  expect(response.ok).toBe(true)
  if (response.ok) return response.result
  return undefined
}

describe('demo:web:real 冒烟（post-MVP 增补：真 adapter 指向本地假端点，零 key）', () => {
  it('真 OpenAI 兼容 HTTP 链路：带当前日期的 system prompt → SSE 流式 → 会话事件 → 轨迹可投影', async () => {
    const stub = await startStubEndpoint()
    const sessionsDir = await mkdtemp(join(tmpdir(), 'mini-dsh-web-real-'))
    let runtime: WebDemoRuntime | undefined
    let client: ReturnType<typeof scriptedClient> | undefined
    try {
      client = scriptedClient()
      const bridge = createRpcBridge()
      bridge.accept(client.hostSide)
      runtime = await createWebDemoRuntime({
        llm: 'real',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${stub.port}`,
        model: 'deepseek-chat',
        port: 0,
        sessionsDir,
        bridge,
      })

      const created = (await okResult(await client.request('session.create', { title: '冒烟' }))) as {
        meta: { id: string }
      }
      await okResult(await client.request('session.send', { id: created.meta.id, content: '今年是哪一年' }))
      const resumed = (await okResult(await client.request('session.resume', { id: created.meta.id }))) as {
        events: SessionEvent[]
      }

      // 1. 真 HTTP 调用发生（本地假端点收到请求），key 与流式都按协议发出
      expect(stub.requests).toHaveLength(1)
      const call = stub.requests[0]!
      expect(call.url).toBe('/chat/completions')
      expect(call.authorization).toBe('Bearer test-key')
      expect(call.body.stream).toBe(true)
      const messages = call.body.messages as Array<{ role: string; content: string }>
      expect(messages[0]!.role).toBe('system')
      expect(messages[0]!.content).toContain('当前时间（UTC）：')
      expect(messages[0]!.content).toContain(new Date().toISOString().slice(0, 10))
      expect(messages[1]).toEqual({ role: 'user', content: '今年是哪一年' })

      // 2. 流式分片 + 终事件 + usage 全部落日志（与 M4 假 LLM 链路同构）
      expect(resumed.events.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant/stream',
        'assistant/stream',
        'assistant/stream',
        'assistant',
        'turn/end',
      ])
      const assistant = resumed.events.find((e) => e.type === 'assistant')!
      expect(assistant.payload).toEqual({
        content: '今年是2026年。',
        usage: { inputTokens: 20, outputTokens: 5 },
      })

      // 3. 轨迹可投影：一轮、分片聚合行 { chunks, joined }（M5 链路对真 adapter 成立）
      const turns = projectTurns(resumed.events)
      expect(turns).toHaveLength(1)
      expect(turns[0]!.userText).toBe('今年是哪一年')
      expect(turns[0]!.endReason).toBe('done')
      const streamRow = turns[0]!.events.find((e) => e.type === 'assistant/stream')!
      expect(streamRow.payload).toEqual({ chunks: ['今年是', '2026年', '。'], joined: '今年是2026年。' })
    } finally {
      client?.close()
      if (runtime) await runtime.stop()
      await stub.close()
      await rm(sessionsDir, { recursive: true, force: true })
    }
  })
})
