import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'
import type { HostMessage, ResponseMessage } from '@mini-dsh/web'
import { createWebDemoRuntime } from '../examples/web-demo-shared'
import type { WebDemoRuntime } from '../examples/web-demo-shared'
import type { SessionEvent, SessionMeta } from '@mini-dsh/session'

/**
 * demo:web:fake 的 M8 委派场景冒烟（零 key）：
 * 同一个 web demo runtime 挂上 subagent/workflow 后，假 LLM 台词本的第一轮是
 * "父调 subagent 工具 → 子 agent 跑 bash date → 子回答 → 父汇报"。
 * 断言三件事（M8 在 Web 里可见 = 工具在列 + 父 tool 事件含子会话 id + 子会话
 * 独立落盘且谱系正确、经会话列表可导航回放）。
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

describe('demo:web:fake 的 M8 委派场景（零 key）', () => {
  it('subagent/workflow 工具在列；第一轮派生子 agent：父 tool 事件含子会话 id、子会话独立可回放', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'mini-dsh-web-m8-'))
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

      // 1. M8 能力在 host 上挂着：工具在列（loop 会把声明传给模型）、两个提供方注册
      expect(runtime.ctx.tools.list().map((t) => t.name)).toEqual(
        expect.arrayContaining(['bash', 'subagent', 'workflow']),
      )
      expect(runtime.ctx.subagents.list().sort()).toEqual(['fork', 'spawn'])

      // 2. 走 RPC 开一轮：台词本第一轮 = subagent 委派场景
      const created = (await okResult(await client.request('session.create', { title: 'M8 Web 演示' }))) as {
        meta: { id: string }
      }
      await okResult(await client.request('session.send', { id: created.meta.id, content: '你好' }))
      const resumed = (await okResult(await client.request('session.resume', { id: created.meta.id }))) as {
        events: SessionEvent[]
      }

      // 父会话：user → assistant(要 subagent 工具) → tool 调用/结果（结果含子会话 id）→ 流式 + 终事件
      const types = resumed.events.map((e) => e.type)
      expect(types.slice(0, 6)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool',
      ])
      const toolResult = resumed.events.find((e) => e.type === 'tool'
        && (e.payload as { output?: unknown }).output !== undefined)!
      const output = (toolResult.payload as { name: string; output: { kind: string; runId: string; output: string } })
      expect(output.name).toBe('subagent')
      expect(output.output.kind).toBe('foreground')
      expect(output.output.runId).toBeTruthy()
      // 父轮次正常收尾（子 agent 的结果已被回收成父的流式汇报）
      expect(resumed.events.at(-1)!.type).toBe('turn/end')
      expect(resumed.events.at(-1)!.payload).toEqual({ reason: 'done' })

      // 3. 子会话独立落盘：谱系正确、经会话列表可导航（RPC 会话列表就是浏览器侧列表）
      const list = (await okResult(await client.request('session.list'))) as SessionMeta[]
      expect(list).toHaveLength(2)
      const child = list.find((m) => m.id === output.output.runId)!
      expect(child.parentSessionId).toBe(created.meta.id)
      expect(child.depth).toBe(1)
      const childResumed = (await okResult(await client.request('session.resume', { id: child.id }))) as {
        events: SessionEvent[]
      }
      expect(childResumed.events.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
    } finally {
      client?.close()
      if (runtime) await runtime.stop()
      await rm(sessionsDir, { recursive: true, force: true })
    }
  })
})
