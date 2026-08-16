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
 * demo:web 的 M9 外部工具场景冒烟（零 key）：runtime 挂 mcp-client（fixture server）
 * 后，假 LLM 台词本第二轮调 mcp__fixture__add（真 stdio 协议 + 真子进程）。
 * 断言三件事（M9 在 Web 里可见 = 工具在列 + tool 事件对入轨迹 + 结果为真调用）。
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

describe('demo:web 的 M9 外部工具场景（零 key）', () => {
  it('mcp 工具在列；第二轮真调用 mcp__fixture__add：tool 事件对入轨迹、结果为真计算', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'mini-dsh-web-m9-'))
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

      // 1. M9 能力在 host 上挂着：外部 server 的工具与本地工具同列
      const toolNames = runtime.ctx.tools.list().map((t) => t.name)
      expect(toolNames).toEqual(expect.arrayContaining(['bash', 'subagent', 'workflow']))
      expect(toolNames).toEqual(expect.arrayContaining([
        'mcp__fixture__add', 'mcp__fixture__greet', 'mcp__fixture__admin_reset',
      ]))
      expect(toolNames).not.toContain('add')

      // 2. 第一轮 = M8 委派场景（回归），第二轮 = M9 外部工具调用
      const created = (await okResult(await client.request('session.create', { title: 'M9 Web 演示' }))) as {
        meta: { id: string }
      }
      await okResult(await client.request('session.send', { id: created.meta.id, content: '第一轮' }))
      await okResult(await client.request('session.send', { id: created.meta.id, content: '第二轮：算 2+3' }))
      const resumed = (await okResult(await client.request('session.resume', { id: created.meta.id }))) as {
        events: SessionEvent[]
      }

      // 两轮都完整：各以 turn/start 开头、turn/end 收尾
      expect(resumed.events.filter((e) => e.type === 'turn/start')).toHaveLength(2)
      expect(resumed.events.filter((e) => e.type === 'turn/end')).toHaveLength(2)

      // 3. MCP 调用入轨迹：tool 事件对（调用 + 结果），结果来自真 server 进程
      const mcpTools = resumed.events.filter((e) =>
        e.type === 'tool' && (e.payload as { name: string }).name === 'mcp__fixture__add')
      expect(mcpTools).toHaveLength(2)
      const call = mcpTools[0]!.payload as { name: string; input: unknown }
      expect(call.input).toEqual({ a: 2, b: 3 })
      const result = mcpTools[1]!.payload as { name: string; input: unknown; output: unknown }
      expect(result.output).toEqual({ content: '5' })

      // 第二轮流式汇报收尾正常
      expect(resumed.events.at(-1)!.type).toBe('turn/end')
      expect(resumed.events.at(-1)!.payload).toEqual({ reason: 'done' })
    } finally {
      client?.close()
      if (runtime) await runtime.stop()
      await rm(sessionsDir, { recursive: true, force: true })
    }
  })
})
