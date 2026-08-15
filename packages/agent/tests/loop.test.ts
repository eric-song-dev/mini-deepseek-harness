import { describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { openSession } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

/**
 * 组装最小 harness：根 ctx 提供假 LLM（provideLlm 插件）→ openSession → 会话 ctx 装 agentLoop。
 * "换 provider = 换插件"：所有测试与 demo 都走这条真实注入链。
 */
async function makeHarness(options: {
  replies?: ConstructorParameters<typeof createFakeLlm>[0]['replies']
  systemPrompt?: string
  events?: readonly SessionEvent[]
} = {}) {
  const { ctx, dispose } = await createTestContext()
  const fake = createFakeLlm({ replies: options.replies ?? [] })
  await ctx.plugin(provideLlm, fake)
  const session = await openSession(ctx, {
    id: 's1',
    meta: { id: 's1', title: '', createdAt: 0 },
    events: options.events,
  })
  session.ctx.plugin(agentLoop, { systemPrompt: options.systemPrompt })
  const loop: AgentLoop = session.ctx['agent-loop']
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
    const a = await openSession(ctx, { id: 'a', meta: { id: 'a', title: '', createdAt: 0 } })
    const b = await openSession(ctx, { id: 'b', meta: { id: 'b', title: '', createdAt: 0 } })
    try {
      a.ctx.plugin(agentLoop)
      b.ctx.plugin(agentLoop)
      const loopA: AgentLoop = a.ctx['agent-loop']
      const loopB: AgentLoop = b.ctx['agent-loop']
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
