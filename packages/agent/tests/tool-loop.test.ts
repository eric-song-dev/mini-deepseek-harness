import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionConfig, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { createToolRegistry, provideTools, UnknownToolError } from '@mini-dsh/tools'
import type { ToolContext, ToolsService } from '@mini-dsh/tools'
import { agentLoop, MaxStepsExceededError } from '@mini-dsh/agent'
import type { AgentLoop, AgentLoopConfig } from '@mini-dsh/agent'

/**
 * 组装带工具的 harness：根 ctx 提供假 LLM + tools 注册表（探针工具记录执行与 ctx），
 * 会话 ctx 装 agentLoop。loop 的 inject: ['llm', 'tools'] 等待两个服务就绪。
 */
async function makeHarness(options: {
  replies?: Parameters<typeof createFakeLlm>[0]['replies']
  systemPrompt?: string
  maxSteps?: number
  meta?: SessionConfig['meta']
  registerProbes?: boolean
} = {}) {
  const { ctx, dispose } = await createTestContext()
  const fake = createFakeLlm({ replies: options.replies ?? [] })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(provideTools, createToolRegistry())
  const executions: Array<{ name: string; input: Record<string, unknown>; ctx: ToolContext; output: unknown }> = []
  const probes: Record<string, unknown> = {
    read: { content: '文件内容' },
    edit: { replaced: true },
  }
  const registry = ctx.get('tools')!
  if (options.registerProbes ?? true) {
    for (const name of ['read', 'edit'] as const) {
      registry.register({
        declaration: {
          name,
          description: `探针 ${name}`,
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        execute: async (input: Record<string, unknown>, toolCtx: ToolContext) => {
          executions.push({ name, input, ctx: toolCtx, output: probes[name] })
          return probes[name]
        },
      })
    }
  }
  const meta = options.meta ?? { id: 's1', title: '', createdAt: 0 }
  const session = await openSession(ctx, { id: meta.id, meta })
  const loopConfig: AgentLoopConfig = {}
  if (options.systemPrompt !== undefined) loopConfig.systemPrompt = options.systemPrompt
  if (options.maxSteps !== undefined) loopConfig.maxSteps = options.maxSteps
  const fiber = await session.ctx.plugin(agentLoop, loopConfig)
  const loop: AgentLoop = fiber.ctx['agent-loop']
  return { ctx, session, fake, loop, executions, dispose }
}

/** 预设"要工具"回复的便捷函数。 */
function toolCall(name: string, id: string, args: Record<string, unknown>) {
  return { toolCalls: [{ id, name, arguments: args }] }
}

describe('agentLoop 工具调用循环（M3）', () => {
  it('多步循环落完整日志：assistant(带 toolCalls) → tool(调用) → tool(结果) → … → assistant(最终) → turn/end(done)', async () => {
    const { session, loop, dispose } = await makeHarness({
      replies: [toolCall('read', 'c1', { path: 'a.txt' }), toolCall('edit', 'c2', { path: 'a.txt' }), { content: '已更新。' }],
    })
    try {
      await loop.chat('帮我读文件再改一下')

      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
        'tool',
        'tool',
        'assistant',
        'turn/end',
      ])
      expect(session.log[3]!.payload).toEqual({
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }],
      })
      expect(session.log[4]!.payload).toEqual({ name: 'read', input: { path: 'a.txt' } })
      expect(session.log[5]!.payload).toEqual({ name: 'read', input: { path: 'a.txt' }, output: { content: '文件内容' } })
      expect(session.log[8]!.payload).toEqual({
        name: 'edit',
        input: { path: 'a.txt' },
        output: { replaced: true },
      })
      expect(session.log[9]!.payload).toEqual({ content: '已更新。' })
      expect(session.log[10]!.payload).toEqual({ reason: 'done' })
    } finally {
      await dispose()
    }
  })

  it('模型每步收到的 messages 含上一步工具结果（role:tool + tool_call_id）；tools 声明每步都传', async () => {
    const { fake, loop, dispose } = await makeHarness({
      replies: [toolCall('read', 'c1', { path: 'a.txt' }), { content: '读完了。' }],
    })
    try {
      await loop.chat('读文件')

      const declared = fake.requests.map((r) => r.tools.map((t) => t.name))
      expect(declared).toEqual([['read', 'edit'], ['read', 'edit']])

      expect(fake.requests[0]!.messages).toEqual([{ role: 'user', content: '读文件' }])
      expect(fake.requests[1]!.messages).toEqual([
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'c1', content: '{"content":"文件内容"}' },
      ])
    } finally {
      await dispose()
    }
  })

  it('两次工具往返：第三次模型输入包含两对完整的 assistant+tool 历史', async () => {
    const { fake, loop, dispose } = await makeHarness({
      replies: [
        toolCall('read', 'c1', { path: 'a.txt' }),
        toolCall('edit', 'c2', { path: 'a.txt' }),
        { content: '完成。' },
      ],
    })
    try {
      await loop.chat('读并改')
      expect(fake.requests).toHaveLength(3)
      expect(fake.requests[2]!.messages).toEqual([
        { role: 'user', content: '读并改' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'c1', content: '{"content":"文件内容"}' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'edit', arguments: { path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'c2', content: '{"replaced":true}' },
      ])
    } finally {
      await dispose()
    }
  })

  it('maxSteps 超限：落 turn/end(reason:limit)、抛 MaxStepsExceededError、不静默空转', async () => {
    const { session, loop, executions, dispose } = await makeHarness({
      maxSteps: 2,
      replies: [
        toolCall('read', 'c1', { path: 'a.txt' }),
        toolCall('read', 'c2', { path: 'a.txt' }),
        toolCall('read', 'c3', { path: 'a.txt' }),
      ],
    })
    try {
      await expect(loop.chat('触发超限')).rejects.toBeInstanceOf(MaxStepsExceededError)

      expect(session.log.at(-1)!.type).toBe('turn/end')
      expect(session.log.at(-1)!.payload).toEqual({ reason: 'limit' })
      expect(executions).toHaveLength(2)
      // 上限内的两步各落一对 tool 事件（调用+结果）
      expect(session.log.filter((e) => e.type === 'tool')).toHaveLength(4)
    } finally {
      await dispose()
    }
  })

  it('模型调用未知工具：turn/end(reason:crash)、原错误（UnknownToolError）上抛', async () => {
    const { session, loop, dispose } = await makeHarness({
      replies: [toolCall('nope', 'c1', {})],
    })
    try {
      await expect(loop.chat('调个不存在的工具')).rejects.toBeInstanceOf(UnknownToolError)
      expect(session.log.at(-1)!.type).toBe('turn/end')
      expect(session.log.at(-1)!.payload).toEqual({ reason: 'crash' })
      expect(session.log.filter((e) => e.type === 'tool')).toHaveLength(1) // 只有调用事件，结果没落
    } finally {
      await dispose()
    }
  })

  it('工具执行的 ctx.cwd 来自会话 meta（工具按会话工作目录解析相对路径）', async () => {
    const { session, loop, executions, dispose } = await makeHarness({
      meta: { id: 's1', title: '', createdAt: 0, cwd: '/custom/work' },
      replies: [toolCall('read', 'c1', { path: 'a.txt' }), { content: 'ok' }],
    })
    try {
      await loop.chat('读')
      expect(session.meta.cwd).toBe('/custom/work')
      expect(executions[0]!.ctx).toEqual({ cwd: '/custom/work' })
    } finally {
      await dispose()
    }
  })

  it('旧会话 meta 没有 cwd 时以进程 cwd 兜底', async () => {
    const { loop, executions, dispose } = await makeHarness({
      replies: [toolCall('read', 'c1', { path: 'a.txt' }), { content: 'ok' }],
    })
    try {
      await loop.chat('读')
      expect(executions[0]!.ctx).toEqual({ cwd: process.cwd() })
    } finally {
      await dispose()
    }
  })

  it('无工具注册时的纯文本回合行为与 M2 一致（回归：不传 tools 不空转）', async () => {
    const { session, fake, loop, dispose } = await makeHarness({
      registerProbes: false,
      replies: [{ content: '你好呀！' }],
    })
    try {
      await loop.chat('你好')
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
      expect(fake.requests[0]!.tools).toEqual([])
      expect(session.log[3]!.payload).toEqual({ content: '你好呀！' })
    } finally {
      await dispose()
    }
  })
})
