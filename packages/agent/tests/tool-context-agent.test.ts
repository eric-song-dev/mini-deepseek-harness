import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import type { Tool } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'

/**
 * M8 任务 2：ToolContext.agent 透传。
 *
 * 背景：subagent 工具需要知道"当前会话"（谱系 meta、fork 种子、观察事件 emit 到哪里），
 * 而 mini 没有上游的 Agent 服务——loop 是唯一知道当前会话的组件。所以 ToolContext
 * （tools seam 的执行上下文）增可选 `agent?: Context` 字段，loop 把会话 ctx 一行透传。
 *
 * 上游同款理由：loop 为每次模型驱动的工具调用设置 exec.agent。
 */
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-agent-ctx-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('M8：loop 把会话 ctx 作为 agent 透传给工具执行上下文', () => {
  it('工具 execute 收到的 ctx.agent 就是会话 ctx（可读 session-log/session-meta）', async () => {
    const root = new Context()
    await root.plugin(jsonlPersistence, { dir })
    await root.plugin(SessionManager)
    const fake = createFakeLlm({ replies: [
      { toolCalls: [{ id: 'p1', name: 'probe', arguments: {} }] },
      { content: '完成' },
    ] })
    await root.plugin(provideLlm, fake)
    await root.plugin(toolRegistry)

    // probe 工具：只捕获执行上下文里的 agent，什么都不做
    let captured: Context | undefined
    const probe: Tool = {
      declaration: { name: 'probe', description: '探针', parameters: { type: 'object' } },
      execute(_input: Record<string, unknown>, toolCtx) {
        captured = toolCtx.agent
        return 'ok'
      },
    }
    await root.plugin(Object.assign((ctx: Context) => {
      ctx.tools.register(probe)
    }, { inject: ['tools'] }))

    const session = await root.get('session-manager')!.create({ title: '透传测试' })
    const fiber = await session.ctx.plugin(agentLoop)
    const loop = fiber.ctx['agent-loop']
    await loop.chat('探测一下')
    await session.flush()

    // agent 就是 loop 的插件 ctx（会话 ctx 的子 ctx）：读会话服务、emit 进会话隔离总线都可用
    expect(captured).toBeDefined()
    expect(captured).toBe(fiber.ctx)
    expect(captured!['session-meta'].id).toBe(session.id)
    expect(captured!['session-log'].events.map((e) => e.type)).toContain('user')

    await root.fiber.dispose()
  })
})
