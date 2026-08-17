import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'
import type { HostMessage, ResponseMessage } from '@mini-dsh/web'
import { createWebDemoRuntime } from '../examples/web-demo-shared'
import type { WebDemoRuntime } from '../examples/web-demo-shared'
import type { SessionEvent } from '@mini-dsh/session'

/**
 * demo:web 的 M10 web search 场景冒烟（零 key）：runtime 挂 web 三层
 * （seam + fakeWebSearch + webSearchTool）后，假 LLM 台词本第三轮调 web_search。
 * 断言三件事（M10 在 Web 里可见 = 工具在列 + tool 事件对入轨迹 + 结果结构化可回放）。
 */

// ---- 脚本化 client（web-demo.test.ts 同款：内存直连 + requestId 配对）----
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

describe('demo:web 的 M10 web search 场景（零 key）', () => {
  it('web_search 工具在列；第三轮调用入轨迹：tool 事件对 + 结构化结果（轨迹面板可直接回放）', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'mini-dsh-web-m10-'))
    let runtime: WebDemoRuntime | undefined
    let client: ReturnType<typeof scriptedClient> | undefined
    try {
      client = scriptedClient()
      const bridge = createRpcBridge()
      bridge.accept(client.hostSide)
      runtime = await createWebDemoRuntime({
        llm: 'fake',
        port: 0,
        sessionsDir,
        bridge,
      })

      // 1. M10 能力在 host 上挂着：web_search 与既有工具同列（消费方稳定注册）
      const toolNames = runtime.ctx.tools.list().map((t) => t.name)
      expect(toolNames).toEqual(expect.arrayContaining(['bash', 'subagent', 'workflow']))
      expect(toolNames).toContain('web_search')

      // 2. 第一轮 = M8 委派（回归），第二轮 = M9 MCP（回归），第三轮 = M10 web search
      const created = (await okResult(await client.request('session.create', { title: 'M10 Web 演示' }))) as {
        meta: { id: string }
      }
      await okResult(await client.request('session.send', { id: created.meta.id, content: '第一轮' }))
      await okResult(await client.request('session.send', { id: created.meta.id, content: '第二轮：算 2+3' }))
      await okResult(await client.request('session.send', { id: created.meta.id, content: '第三轮：搜一下事件溯源' }))
      const resumed = (await okResult(await client.request('session.resume', { id: created.meta.id }))) as {
        events: SessionEvent[]
      }

      // 三轮都完整：各以 turn/start 开头、turn/end 收尾
      expect(resumed.events.filter((e) => e.type === 'turn/start')).toHaveLength(3)
      expect(resumed.events.filter((e) => e.type === 'turn/end')).toHaveLength(3)

      // 3. web_search 调用入轨迹：tool 事件对（调用 + 结果），结果来自 fakeWebSearch（零 key）
      const searchTools = resumed.events.filter((e) =>
        e.type === 'tool' && (e.payload as { name: string }).name === 'web_search')
      expect(searchTools).toHaveLength(2)
      const call = searchTools[0]!.payload as { name: string; input: unknown }
      expect(call.input).toEqual({ query: '事件溯源 event sourcing' })
      const result = searchTools[1]!.payload as { name: string; input: unknown; output: unknown }
      const output = result.output as { content?: string; sources: Array<{ url: string }>; truncated: boolean }
      expect(output.content).toBeDefined()
      expect(output.sources.length).toBeGreaterThan(0)
      expect(output.truncated).toBe(false)

      // 第三轮流式汇报收尾正常
      expect(resumed.events.at(-1)!.type).toBe('turn/end')
      expect(resumed.events.at(-1)!.payload).toEqual({ reason: 'done' })
    } finally {
      client?.close()
      if (runtime) await runtime.stop()
      await rm(sessionsDir, { recursive: true, force: true })
    }
  })
})
