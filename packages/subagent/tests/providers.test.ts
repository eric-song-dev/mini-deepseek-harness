import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'
import { forkProvider, spawnProvider, SubagentRuntime } from '@mini-dsh/subagent'

/**
 * M8 任务 4：spawn / fork 进程内提供方（复用 mini 的 agentLoop + session-manager +
 * llm + tools，一个 `startInProcessRun(request, {seed?})` 五步驱动器）。
 *
 * 契约主题（上游 subagent-in-process-driver 的 mini 版）：
 * - spawn：子会话 = 独立 Session（谱系 meta：parentSessionId/depth、cwd 继承），
 *   子 agent 以空对话开始跑一轮，result output = 最后一条非空 assistant 文本；
 * - fork：seed = 父日志截至最后一个 turn/end 的轮次事件（进行中轮次排除；无已
 *   完成轮次时等价 spawn）；子模型第一次调用看到的 messages 含父历史；
 * - result 不 reject：子级 crash → stopReason 'error'；
 * - 启动前 signal 中止 → start 拒绝（不建子会话、无事件对）；
 * - 父会话零污染；子会话 JSONL 独立落盘可回放。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-provider-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Runtime {
  ctx: Context
  fake: ReturnType<typeof createFakeLlm>
  dispose: () => Promise<void>
}

/** 启动最小 runtime：JSONL + SessionManager + 假 LLM + 空工具注册表 + subagents + 提供方。 */
async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies']): Promise<Runtime> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawnProvider)
  await ctx.plugin(forkProvider)
  return { ctx, fake, dispose }
}

/** 开一个父会话（带 cwd），装 loop 并返回 loop 句柄。 */
async function openParent(ctx: Context): Promise<{ session: Session; loop: AgentLoop; parentCtx: Context }> {
  const session = await ctx.get('session-manager')!.create({ title: '父会话', cwd: '/work-parent' })
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '父系统提示' })
  return { session, loop: fiber.ctx['agent-loop'], parentCtx: fiber.ctx }
}

describe('spawn / fork 提供方（M8 任务 4）', () => {
  it('spawn：建独立子会话（谱系 meta 齐全），子 agent 空对话跑一轮，result 输出 = 最后非空 assistant 文本', async () => {
    const runtime = await boot([{ content: '子回答' }])
    try {
      const { session: parent, parentCtx } = await openParent(runtime.ctx)

      const run = await runtime.ctx.subagents.start('spawn', {
        label: '子任务 A',
        prompt: '请完成子任务',
        parent: parentCtx,
      })
      const result = await run.result
      await run.dispose()

      // run.id == 子会话 id；子会话独立可回放（JSONL 已落盘）
      const child = await runtime.ctx.get('session-manager')!.resume(run.id)
      expect(result).toEqual({ output: '子回答', stopReason: 'completed' })
      expect(child.meta).toMatchObject({
        parentSessionId: parent.id,
        depth: 1,
        cwd: '/work-parent',
        title: '子任务 A',
      })
      expect(child.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
      expect(child.log.at(-2)!.payload).toEqual({ content: '子回答', usage: { inputTokens: 1, outputTokens: 1 } })

      // 子模型以空对话开始：第一次调用只有用户消息（没有父历史、没有父系统提示）
      expect(runtime.fake.requests[0]!.messages).toEqual([
        { role: 'user', content: '请完成子任务' },
      ])

      // 父会话零污染：只有头记录
      expect(parent.log.map((e) => e.type)).toEqual(['session/created'])
    } finally {
      await runtime.dispose()
    }
  })

  it('子模型 crash → stopReason error（result 不 reject，消费方拿结果不是异常）', async () => {
    const runtime = await boot([]) // 假 LLM 耗尽 → 子模型调用直接抛
    try {
      const { parentCtx } = await openParent(runtime.ctx)
      const run = await runtime.ctx.subagents.start('spawn', { prompt: '会崩的任务', parent: parentCtx })
      const result = await run.result
      await run.dispose()

      expect(result.stopReason).toBe('error')
      expect(result.output).toBe('')

      // 子会话落盘了崩溃的完整轮次（turn/end reason: crash），可回放
      const child = await runtime.ctx.get('session-manager')!.resume(run.id)
      expect(child.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'turn/end',
      ])
      expect(child.log.at(-1)!.payload).toEqual({ reason: 'crash' })
    } finally {
      await runtime.dispose()
    }
  })

  it('signal 已中止 → start 拒绝（不建子会话、不 emit 事件对）', async () => {
    const runtime = await boot([{ content: '不该跑' }])
    try {
      const { parentCtx } = await openParent(runtime.ctx)
      const seen: unknown[][] = []
      parentCtx.on('subagent/start', (...args: unknown[]) => { seen.push(args) })
      parentCtx.on('subagent/end', (...args: unknown[]) => { seen.push(args) })

      const controller = new AbortController()
      controller.abort()
      await expect(
        runtime.ctx.subagents.start('spawn', { prompt: '任务', parent: parentCtx, signal: controller.signal }),
      ).rejects.toThrow(/发布前/)

      expect(seen).toEqual([])
      // 只有父会话一个 JSONL（子会话从未创建）
      expect(await runtime.ctx.get('session-manager')!.list()).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('fork：seed = 父已完成轮次前缀（子模型第一次调用含父历史）；输出只取子自己的 assistant', async () => {
    const runtime = await boot([
      { content: '父回答1' },
      { content: '父回答2' },
      { content: '子回答' },
    ])
    try {
      const { session: parent, loop, parentCtx } = await openParent(runtime.ctx)
      await loop.chat('父问题1')
      await loop.chat('父问题2')

      const run = await runtime.ctx.subagents.start('fork', { prompt: '子任务', parent: parentCtx })
      const result = await run.result
      await run.dispose()

      expect(result).toEqual({ output: '子回答', stopReason: 'completed' })

      // 子模型第一次调用：父两轮历史 + 子任务（无父系统提示）
      expect(runtime.fake.requests[2]!.messages).toEqual([
        { role: 'user', content: '父问题1' },
        { role: 'assistant', content: '父回答1' },
        { role: 'user', content: '父问题2' },
        { role: 'assistant', content: '父回答2' },
        { role: 'user', content: '子任务' },
      ])

      // 子会话日志 = 头记录 + 父两轮（8 条种子）+ 子一轮（4 条）
      const child = await runtime.ctx.get('session-manager')!.resume(run.id)
      expect(child.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start', 'user', 'assistant', 'turn/end',
        'turn/start', 'user', 'assistant', 'turn/end',
        'turn/start', 'user', 'assistant', 'turn/end',
      ])
      // 父会话依旧零污染（子 agent 不写父）
      expect(parent.log).toHaveLength(9)
    } finally {
      await runtime.dispose()
    }
  })

  it('进行中的父轮次不进 fork 种子（截至最后一个 turn/end 的平衡前缀）', async () => {
    const runtime = await boot([{ content: '父回答1' }, { content: '子回答' }])
    try {
      const { loop, parentCtx } = await openParent(runtime.ctx)
      await loop.chat('父问题1')

      // 父会话当前有一轮"进行中"（只有 turn/start+user，还没 turn/end）——
      // 这正是 tool 执行期间的父日志形态
      parentCtx.emit('turn/start')
      parentCtx.emit('user', { content: '进行中的问题（不该进种子）' })

      const run = await runtime.ctx.subagents.start('fork', { prompt: '子任务', parent: parentCtx })
      await run.result
      await run.dispose()

      // 种子只含已完成的第一轮
      expect(runtime.fake.requests[1]!.messages).toEqual([
        { role: 'user', content: '父问题1' },
        { role: 'assistant', content: '父回答1' },
        { role: 'user', content: '子任务' },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('父没有任何已完成轮次时 fork 等价 spawn（空种子、空对话开始）', async () => {
    const runtime = await boot([{ content: '子回答' }])
    try {
      const { parentCtx } = await openParent(runtime.ctx)
      const run = await runtime.ctx.subagents.start('fork', { prompt: '子任务', parent: parentCtx })
      await run.result
      await run.dispose()

      expect(runtime.fake.requests[0]!.messages).toEqual([
        { role: 'user', content: '子任务' },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('dispose 幂等：多次调用安全；子会话资源已排空（JSONL 完整可读）', async () => {
    const runtime = await boot([{ content: '子回答' }])
    try {
      const { parentCtx } = await openParent(runtime.ctx)
      const run = await runtime.ctx.subagents.start('spawn', { prompt: '子任务', parent: parentCtx })
      await run.result
      await run.dispose()
      await run.dispose() // 幂等

      const lines = (await readFile(resolve(dir, `${run.id}.jsonl`), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(5)
      expect(lines.at(-1)).toContain('"turn/end"')
    } finally {
      await runtime.dispose()
    }
  })
})
