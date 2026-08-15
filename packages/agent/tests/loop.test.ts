import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionConfig, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { createToolRegistry, provideTools } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop, AgentLoopConfig } from '@mini-dsh/agent'

/**
 * 组装最小 harness：根 ctx 提供假 LLM（provideLlm）与 tools 注册表（provideTools，
 * M3 起 loop 的 inject 依赖它）→ openSession → 会话 ctx 装 agentLoop。
 * "换 provider = 换插件"：所有测试与 demo 都走这条真实注入链。
 */
async function makeHarness(options: {
  replies?: Parameters<typeof createFakeLlm>[0]['replies']
  systemPrompt?: string
  stream?: boolean
  events?: readonly SessionEvent[]
} = {}) {
  const { ctx, dispose } = await createTestContext()
  const fake = createFakeLlm({ replies: options.replies ?? [] })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(provideTools, createToolRegistry())
  // 探针工具 echo：流式混合测试里给模型一个可用的真工具。
  ctx.get('tools')!.register({
    declaration: { name: 'echo', description: '回显文本', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
    execute: async (input: Record<string, unknown>) => ({ echoed: input.text }),
  })
  const sessionConfig: SessionConfig = { id: 's1', meta: { id: 's1', title: '', createdAt: 0 } }
  if (options.events !== undefined) sessionConfig.events = options.events
  const session = await openSession(ctx, sessionConfig)
  const loopConfig: AgentLoopConfig = {}
  if (options.systemPrompt !== undefined) loopConfig.systemPrompt = options.systemPrompt
  if (options.stream !== undefined) loopConfig.stream = options.stream
  // ctx.plugin 给插件的是会话 ctx 的子 ctx（自己的 fiber 作用域）；loop 句柄挂在该 ctx 上。
  const fiber = await session.ctx.plugin(agentLoop, loopConfig)
  const loop: AgentLoop = fiber.ctx['agent-loop']
  return { ctx, session, fake, loop, dispose }
}

describe('agentLoop（全仓唯一具体循环逻辑，M2）', () => {
  it('单轮 chat 落完整 turn 序列：turn/start → user → assistant → turn/end(done)，载荷无损', async () => {
    const { session, fake, loop, dispose } = await makeHarness({ replies: [{ content: '你好呀！' }] })
    try {
      await loop.chat('你好')

      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
      expect(session.log[2]!.payload).toEqual({ content: '你好' })
      expect(session.log[3]!.payload).toEqual({ content: '你好呀！' })
      expect(session.log[4]!.payload).toEqual({ reason: 'done' })
      expect(fake.remaining).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('模型收到的 messages == 日志投影（输入读日志，不另存消息数组）', async () => {
    const { fake, loop, dispose } = await makeHarness({ replies: [{ content: 'r' }] })
    try {
      await loop.chat('你好')
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]!.messages).toEqual([{ role: 'user', content: '你好' }])
    } finally {
      await dispose()
    }
  })

  it('systemPrompt 拼在模型输入头部（M2 最小组合）', async () => {
    const { fake, loop, dispose } = await makeHarness({
      replies: [{ content: 'r' }],
      systemPrompt: '你是教学助手',
    })
    try {
      await loop.chat('在吗')
      expect(fake.requests[0]!.messages).toEqual([
        { role: 'system', content: '你是教学助手' },
        { role: 'user', content: '在吗' },
      ])
    } finally {
      await dispose()
    }
  })

  it('连续两轮：各自成对落日志，第二轮的模型输入含第一轮问答', async () => {
    const { session, fake, loop, dispose } = await makeHarness({
      replies: [{ content: '回答一' }, { content: '回答二' }],
    })
    try {
      await loop.chat('第一问')
      await loop.chat('第二问')

      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
      expect(fake.requests[1]!.messages).toEqual([
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '回答一' },
        { role: 'user', content: '第二问' },
      ])
    } finally {
      await dispose()
    }
  })

  it('llm 异常：落 turn/end(reason:crash)、不落 assistant、原错误向上抛', async () => {
    const { session, loop, dispose } = await makeHarness({ replies: [] })
    try {
      await expect(loop.chat('触发崩溃')).rejects.toThrow()
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'turn/end',
      ])
      expect(session.log.at(-1)!.payload).toEqual({ reason: 'crash' })
    } finally {
      await dispose()
    }
  })

  it('并发两轮被串行化：日志严格按轮成对（带延迟的假 LLM 验证）', async () => {
    const { session, loop, dispose } = await makeHarness({
      replies: [
        { content: '慢回复 A', delay: 30 },
        { content: '快回复 B', delay: 5 },
      ],
    })
    try {
      const [first, second] = [loop.chat('一'), loop.chat('二')]
      await Promise.all([first, second])

      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
      const payloads = session.log.filter((e) => e.type === 'user' || e.type === 'assistant').map((e) => e.payload)
      expect(payloads).toEqual([
        { content: '一' },
        { content: '慢回复 A' },
        { content: '二' },
        { content: '快回复 B' },
      ])
    } finally {
      await dispose()
    }
  })

  it('resume 历史续接：预置日志开会话，模型输入包含历史问答', async () => {
    const history: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 0, payload: { id: 's1', title: '', createdAt: 0 } },
      { seq: 2, type: 'turn/start', ts: 1, payload: undefined },
      { seq: 3, type: 'user', ts: 2, payload: { content: '之前的问题' } },
      { seq: 4, type: 'assistant', ts: 3, payload: { content: '之前的回答' } },
      { seq: 5, type: 'turn/end', ts: 4, payload: { reason: 'done' } },
    ]
    const { session, fake, loop, dispose } = await makeHarness({
      replies: [{ content: '新回答' }],
      events: history,
    })
    try {
      await loop.chat('继续聊')
      expect(fake.requests[0]!.messages).toEqual([
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
        { role: 'user', content: '继续聊' },
      ])
      expect(session.log).toHaveLength(9)
    } finally {
      await dispose()
    }
  })

  it('并存的两个会话各自装 loop 互不串（每会话自有 agent-loop 实例）', async () => {
    const { ctx, dispose } = await createTestContext()
    const fake = createFakeLlm({ replies: [{ content: '给 A' }, { content: '给 B' }] }) as FakeLlm
    await ctx.plugin(provideLlm, fake)
    await ctx.plugin(provideTools, createToolRegistry())
    const a = await openSession(ctx, { id: 'a', meta: { id: 'a', title: '', createdAt: 0 } })
    const b = await openSession(ctx, { id: 'b', meta: { id: 'b', title: '', createdAt: 0 } })
    try {
      const fiberA = await a.ctx.plugin(agentLoop)
      const fiberB = await b.ctx.plugin(agentLoop)
      const loopA: AgentLoop = fiberA.ctx['agent-loop']
      const loopB: AgentLoop = fiberB.ctx['agent-loop']
      expect(loopA).not.toBe(loopB)
      await loopA.chat('A 的问题')
      await loopB.chat('B 的问题')
      expect(a.log.map((e) => e.payload)).toEqual([
        { id: 'a', title: '', createdAt: 0 },
        undefined,
        { content: 'A 的问题' },
        { content: '给 A' },
        { reason: 'done' },
      ])
      expect(b.log.map((e) => e.payload)).toEqual([
        { id: 'b', title: '', createdAt: 0 },
        undefined,
        { content: 'B 的问题' },
        { content: '给 B' },
        { reason: 'done' },
      ])
    } finally {
      await dispose()
    }
  })
})

describe('agentLoop 流式（M4）', () => {
  it('stream 开启：assistant/stream 分片按顺序落日志，assistant 终事件为拼接全文', async () => {
    const { session, loop, dispose } = await makeHarness({
      replies: [{ chunks: ['你', '好', '呀'] }],
      stream: true,
    })
    try {
      await loop.chat('你好')
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant/stream',
        'assistant/stream',
        'assistant/stream',
        'assistant',
        'turn/end',
      ])
      expect(session.log.map((e) => e.payload)).toEqual([
        { id: 's1', title: '', createdAt: 0 },
        undefined,
        { content: '你好' },
        { content: '你' },
        { content: '好' },
        { content: '呀' },
        { content: '你好呀' },
        { reason: 'done' },
      ])
    } finally {
      await dispose()
    }
  })

  it('stream 未开（默认）：无 assistant/stream 事件，chunks 台词静默拼全文（与 M2/M3 一致）', async () => {
    const { session, loop, dispose } = await makeHarness({ replies: [{ chunks: ['你', '好'] }] })
    try {
      await loop.chat('你好')
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(session.log[3]!.payload).toEqual({ content: '你好' })
    } finally {
      await dispose()
    }
  })

  it('stream 开启但实现无分片（非流式实现回退）：无 stream 事件，assistant 终事件一次性', async () => {
    const { session, loop, dispose } = await makeHarness({
      replies: [{ content: '普通回复' }],
      stream: true,
    })
    try {
      await loop.chat('在吗')
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(session.log[3]!.payload).toEqual({ content: '普通回复' })
    } finally {
      await dispose()
    }
  })

  it('工具往返 + 流式最终回答混合：工具轮无分片，最终回复分片逐条落日志', async () => {
    const { session, fake, loop, dispose } = await makeHarness({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
        { chunks: ['收到', '！'] },
      ],
      stream: true,
    })
    try {
      await loop.chat('回显一下')
      expect(session.log.map((e) => e.type)).toEqual([
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
      // 工具轮 assistant 载荷是"要工具"，不带分片；最终 assistant 是拼接全文
      expect(session.log[3]!.payload).toEqual({
        content: '',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }],
      })
      expect(session.log.at(-2)!.payload).toEqual({ content: '收到！' })
      // 第二轮的模型输入：工具结果已回填 messages（M3 行为在流式下不变）
      expect(fake.requests[1]!.messages.slice(-2)).toEqual([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ echoed: '喂' }) },
      ])
    } finally {
      await dispose()
    }
  })
})
