import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createRpcBridge, memoryConnectionPair, webHost } from '@mini-dsh/web'
import type { EventMessage, HostMessage, ResponseMessage, WebHostHandle, WebHostOptions } from '@mini-dsh/web'

/** 脚本化 client（内存直连）：request 返回配对响应，事件进收件箱。 */
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
  const events = (): EventMessage[] => inbox.filter((m): m is EventMessage => m.kind === 'event')
  return { hostSide, clientSide, inbox, request, events }
}

/** 组装最小 host runtime：JSONL 后端 + SessionManager + 假 LLM + 探针工具 + webHost（注入内存桥）。 */
async function makeHost(options: {
  replies?: Parameters<typeof createFakeLlm>[0]['replies']
  stream?: boolean
  staticDir?: string
  systemPrompt?: string
} = {}) {
  const { ctx, dispose } = await createTestContext()
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-web-'))
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(provideLlm, createFakeLlm({ replies: options.replies ?? [] }))
  await ctx.plugin(toolRegistry)
  ctx.get('tools')!.register({
    declaration: {
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    execute: async (input: Record<string, unknown>) => ({ echoed: input.text }),
  })
  const client = scriptedClient()
  const bridge = createRpcBridge()
  bridge.accept(client.hostSide)
  const webOptions: WebHostOptions = { port: 0, bridge }
  if (options.stream !== undefined) webOptions.stream = options.stream
  if (options.staticDir !== undefined) webOptions.staticDir = options.staticDir
  if (options.systemPrompt !== undefined) webOptions.systemPrompt = options.systemPrompt
  const fiber = await ctx.plugin(webHost, webOptions)
  const handle: WebHostHandle = fiber.ctx['web-host']
  return { ctx, dispose, client, handle, dir }
}

async function okResult(response: ResponseMessage): Promise<unknown> {
  expect(response.ok).toBe(true)
  if (response.ok) return response.result
  return undefined
}

/** 便捷：create 并解出 meta。 */
async function createSession(
  request: (method: string, params?: unknown) => Promise<ResponseMessage>,
  title: string,
): Promise<{ id: string; title: string }> {
  const result = (await okResult(await request('session.create', { title }))) as {
    meta: { id: string; title: string }
    events: SessionEvent[]
  }
  return result.meta
}

describe('webHost：SessionManager 门面 RPC（内存桥，M4）', () => {
  it('session.list 初始为空；session.create 两个后按新的在前排列', async () => {
    const host = await makeHost()
    try {
      expect(await okResult(await host.client.request('session.list'))).toEqual([])
      const first = await createSession(host.client.request, '会话一')
      const second = await createSession(host.client.request, '会话二')
      const list = (await okResult(await host.client.request('session.list'))) as Array<{ title: string }>
      expect(list).toHaveLength(2)
      expect(list[0]).toMatchObject({ title: '会话二', id: second.id })
      expect(list[1]).toMatchObject({ title: '会话一', id: first.id })
    } finally {
      await host.dispose()
    }
  })

  it('session.create 返回 meta 与初始日志（含 session/created 头记录），且会话已常驻可立即 send', async () => {
    const host = await makeHost({ replies: [{ content: '你好呀' }] })
    try {
      const result = (await okResult(await host.client.request('session.create', { title: 's' }))) as {
        meta: { id: string }
        events: SessionEvent[]
      }
      expect(result.events.map((e) => e.type)).toEqual(['session/created'])
      const meta = result.meta
      const send = await host.client.request('session.send', { id: meta.id, content: '你好' })
      expect(send.ok).toBe(true)
      expect(host.client.events().map((m) => m.event.type)).toEqual([
        'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(host.client.events().map((m) => m.sessionId)).toEqual([meta.id, meta.id, meta.id, meta.id])
    } finally {
      await host.dispose()
    }
  })

  it('session.send 落全事件序列（工具往返 + 流式分片），tool 调用/结果对与分片按日志顺序推送', async () => {
    const host = await makeHost({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
        { chunks: ['完成', '！'] },
      ],
      stream: true,
    })
    try {
      const meta = await createSession(host.client.request, 's')
      await host.client.request('session.send', { id: meta.id, content: '回显一下' })
      const events = host.client.events()
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
      expect(events.map((m) => m.event.payload)).toEqual([
        undefined,
        { content: '回显一下' },
        { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }], usage: { inputTokens: 1, outputTokens: 1 } },
        { name: 'echo', input: { text: '喂' } },
        { name: 'echo', input: { text: '喂' }, output: { echoed: '喂' } },
        { content: '完成' },
        { content: '！' },
        { content: '完成！', usage: { inputTokens: 1, outputTokens: 1 } },
        { reason: 'done' },
      ])
    } finally {
      await host.dispose()
    }
  })

  it('session.resume 返回完整历史；断线重连后 send 的新事件推给新连接', async () => {
    const host = await makeHost({ replies: [{ content: '第一答' }, { content: '第二答' }] })
    try {
      const meta = await createSession(host.client.request, 's')
      await host.client.request('session.send', { id: meta.id, content: '第一问' })
      // 断线：旧连接关闭，重连新内存连接
      host.client.clientSide.close()
      const reconnected = scriptedClient()
      host.ctx['rpc-bridge'].accept(reconnected.hostSide)

      const resumed = (await okResult(await reconnected.request('session.resume', { id: meta.id }))) as {
        meta: unknown
        events: SessionEvent[]
      }
      expect((resumed.meta as { id: string }).id).toBe(meta.id)
      expect(resumed.events.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])

      await reconnected.request('session.send', { id: meta.id, content: '第二问' })
      expect(reconnected.events().map((m) => m.event.type)).toEqual([
        'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(reconnected.events()[1]!.event.payload).toEqual({ content: '第二问' })
      expect(reconnected.events()[2]!.event.payload).toEqual({ content: '第二答', usage: { inputTokens: 1, outputTokens: 1 } })
    } finally {
      await host.dispose()
    }
  })

  it('resume 未知会话 → ok:false + SessionNotFoundError', async () => {
    const host = await makeHost()
    try {
      const response = await host.client.request('session.resume', { id: 'nope' })
      expect(response).toMatchObject({ ok: false, error: { name: 'SessionNotFoundError' } })
    } finally {
      await host.dispose()
    }
  })

  it('send 到未知会话 → ok:false + SessionNotFoundError', async () => {
    const host = await makeHost()
    try {
      const response = await host.client.request('session.send', { id: 'nope', content: 'x' })
      expect(response).toMatchObject({ ok: false, error: { name: 'SessionNotFoundError' } })
    } finally {
      await host.dispose()
    }
  })

  it('坏参数 → ok:false + BadParamsError（title 非字符串 / send 缺 content）', async () => {
    const host = await makeHost()
    try {
      const badTitle = await host.client.request('session.create', { title: 42 })
      expect(badTitle).toMatchObject({ ok: false, error: { name: 'BadParamsError' } })
      const meta = await createSession(host.client.request, 's')
      const badSend = await host.client.request('session.send', { id: meta.id })
      expect(badSend).toMatchObject({ ok: false, error: { name: 'BadParamsError' } })
    } finally {
      await host.dispose()
    }
  })

  it('send 触发崩溃（假 LLM 台词耗尽）：响应 ok:false，事件序列落 turn/end(crash)', async () => {
    const host = await makeHost({ replies: [] })
    try {
      const meta = await createSession(host.client.request, 's')
      const send = await host.client.request('session.send', { id: meta.id, content: '触发崩溃' })
      expect(send).toMatchObject({ ok: false, error: { name: 'FakeLlmExhaustedError' } })
      expect(host.client.events().map((m) => m.event.type)).toEqual(['turn/start', 'user', 'turn/end'])
      expect(host.client.events().at(-1)!.event.payload).toEqual({ reason: 'crash' })
    } finally {
      await host.dispose()
    }
  })
})

describe('webHost：HTTP 静态文件服务（M4）', () => {
  it('serve staticDir：/ 返回 index.html，按扩展名给 content-type，缺文件 404，目录穿越 403', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'mini-dsh-static-'))
    await writeFile(join(staticDir, 'index.html'), '<html>你好</html>', 'utf8')
    await mkdir(join(staticDir, 'assets'))
    await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log(1)', 'utf8')
    const host = await makeHost({ staticDir })
    try {
      const base = `http://127.0.0.1:${host.handle.port}`
      const index = await fetch(`${base}/`)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(await index.text()).toBe('<html>你好</html>')

      const js = await fetch(`${base}/assets/app.js`)
      expect(js.status).toBe(200)
      expect(js.headers.get('content-type')).toContain('text/javascript')

      const missing = await fetch(`${base}/nope.txt`)
      expect(missing.status).toBe(404)

      // '..%2F' 不会被 URL 解析器当点段归一化，解码后才是 '../'——真正打到守卫的穿越形态
      const traversal = await fetch(`${base}/..%2F..%2Fetc/passwd`)
      expect(traversal.status).toBe(403)
    } finally {
      await rm(staticDir, { recursive: true, force: true })
      await host.dispose()
    }
  })
})
