import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext, createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'
import { forkProvider, spawnProvider, SubagentRuntime, toolSubagent } from '@mini-dsh/subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@mini-dsh/subagent'

/**
 * M8 任务 5：tool-subagent —— 面向模型的委派工具。
 *
 * 契约主题（上游 tool-subagent 的 mini 版）：
 * - 跟随 provider 生命周期：provider 在时挂工具、不在时不挂、被移除时摘（sibling
 *   加载顺序无关、HMR 替换安全）；
 * - description 按 provider.inheritsParentContext 措辞（spawn="看不到本对话" /
 *   fork="继承已完成轮次"）；
 * - 前台收集：await result + 总是 dispose；completed → {kind:'foreground', runId,
 *   output}；非 completed → isError（错误消息带子 agent 保留的部分输出）；
 * - 无 agent 上下文（loop 之外直接 execute）→ 抛错；
 * - 父会话只多 tool 调用/结果事件（结果含子会话 id）；子会话独立落盘。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-tool-subagent-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 可编程假提供方：start 记录调用、返回可定制的 run。 */
function makeFakeProvider(overrides: Partial<SubagentResult> = {}): {
  provider: SubagentProvider
  runs: SubagentRun[]
  disposed: number[]
} {
  const runs: SubagentRun[] = []
  const disposed: number[] = []
  const provider: SubagentProvider = {
    name: 'fake',
    inheritsParentContext: false,
    async start(request) {
      const run: SubagentRun = {
        id: `child-${runs.length + 1}`,
        result: Promise.resolve({ output: '假回答', stopReason: 'completed', ...overrides }),
        dispose: async () => { disposed.push(runs.length) },
      }
      runs.push(run)
      return run
    },
  }
  return { provider, runs, disposed }
}

/** 启动最小 runtime：JSONL + SessionManager + 假 LLM + tools + subagents。 */
async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies'] = []) {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(SubagentRuntime)
  return { ctx, fake, dispose }
}

async function openSession(ctx: Context): Promise<{ session: Session; loop: AgentLoop }> {
  const session = await ctx.get('session-manager')!.create({ title: '父会话' })
  const fiber = await session.ctx.plugin(agentLoop)
  return { session, loop: fiber.ctx['agent-loop'] }
}

describe('tool-subagent（M8 任务 5）', () => {
  it('跟随 provider 生命周期：provider 后到才挂、移除即摘；description 按 inheritsParentContext 措辞', async () => {
    const { ctx, dispose } = await boot()
    try {
      await ctx.plugin(toolSubagent, { provider: 'spawn' })

      // provider 不在：不挂工具
      expect(ctx.tools.list().map((t) => t.name)).toEqual([])

      // provider 后到：挂载（spawn 措辞）
      const spawnFiber = await ctx.plugin(spawnProvider)
      expect(ctx.tools.list().map((t) => t.name)).toEqual(['subagent'])
      expect(ctx.tools.get('subagent')!.declaration.description).toContain('看不到本对话')

      // provider 被移除：摘除（HMR 替换安全）
      await spawnFiber.dispose()
      expect(ctx.tools.list()).toEqual([])

      // fork provider 已注册在前、工具插件后到：挂载（fork 措辞）
      await ctx.plugin(forkProvider)
      const forkPlugin = await ctx.plugin(toolSubagent, { provider: 'fork' })
      expect(ctx.tools.list().map((t) => t.name)).toEqual(['subagent'])
      expect(ctx.tools.get('subagent')!.declaration.description).toContain('已完成轮次')

      // 卸载工具插件 fiber：工具消失（注册可逆）
      await forkPlugin.dispose()
      expect(ctx.tools.list()).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('前台收集：completed → {kind, runId, output}，且总是 dispose（run 释放）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeFakeProvider()
      ctx.subagents.registerProvider(fake.provider)
      await ctx.plugin(toolSubagent, { provider: 'fake' })

      const { session } = await openSession(ctx)
      const output = await ctx.tools.execute(
        'subagent',
        { description: '假任务', prompt: '做点事' },
        { cwd: process.cwd(), agent: session.ctx },
      )
      expect(output).toEqual({ kind: 'foreground', runId: 'child-1', output: '假回答' })
      expect(fake.disposed).toEqual([0])
    } finally {
      await dispose()
    }
  })

  it('非 completed → isError：错误消息带子 agent 保留的部分输出（截断回答不冒充成功）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeFakeProvider({ output: '我做了前半段', stopReason: 'error' })
      ctx.subagents.registerProvider(fake.provider)
      await ctx.plugin(toolSubagent, { provider: 'fake' })

      const { session } = await openSession(ctx)
      await expect(
        ctx.tools.execute(
          'subagent',
          { description: '假任务', prompt: '做点事' },
          { cwd: process.cwd(), agent: session.ctx },
        ),
      ).rejects.toThrow(/subagent run failed[\s\S]*我做了前半段/)
      expect(fake.disposed).toEqual([0]) // 失败路径也 dispose
    } finally {
      await dispose()
    }
  })

  it('无 agent 上下文（loop 之外直接 execute）→ 抛错：委派必须有归属的父会话', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeFakeProvider()
      ctx.subagents.registerProvider(fake.provider)
      await ctx.plugin(toolSubagent, { provider: 'fake' })

      await expect(
        ctx.tools.execute('subagent', { prompt: '做点事' }, { cwd: process.cwd() }),
      ).rejects.toThrow(/agent/)
      expect(fake.runs).toHaveLength(0) // 没归属就不委派
    } finally {
      await dispose()
    }
  })

  it('集成：loop 台词驱动真 spawn 提供方——父只多 tool 事件对（结果含子会话 id），子会话独立可回放', async () => {
    const { ctx, fake, dispose } = await boot([
      { toolCalls: [{ id: 's1', name: 'subagent', arguments: { description: '算一下', prompt: '请算出答案' } }] },
      { content: '子回答：42' },
      { content: '委派完成' },
    ])
    try {
      await ctx.plugin(spawnProvider)
      await ctx.plugin(toolSubagent)
      const { session, loop } = await openSession(ctx)
      await loop.chat('帮我委派一个子任务')
      await session.flush()

      // 模型调用顺序：父#1（要工具）→ 子#1（子任务）→ 父#2（继续对话）
      expect(fake.requests[1]!.messages).toEqual([{ role: 'user', content: '请算出答案' }])
      expect(fake.requests[2]!.messages.at(-1)).toEqual({ role: 'user', content: '帮我委派一个子任务' })

      // 父会话只多 tool 调用/结果事件对；结果 = 规范值 {kind, runId, output}
      const toolResult = session.log.find((e) => e.type === 'tool' && e.payload !== undefined && (e.payload as { output?: unknown }).output !== undefined)!
      const output = (toolResult.payload as { output: { kind: string; runId: string; output: string } }).output
      expect(output).toEqual({ kind: 'foreground', runId: output.runId, output: '子回答：42' })
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])

      // 子会话独立落盘可回放（谱系正确）
      const child = await ctx.get('session-manager')!.resume(output.runId)
      expect(child.meta).toMatchObject({ parentSessionId: session.id, depth: 1 })
      expect(child.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'turn/end',
      ])
    } finally {
      await dispose()
    }
  })

  it('HMR-safety：卸载 toolSubagent 插件 fiber → 工具从注册表消失', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.subagents.registerProvider(makeFakeProvider().provider)
      const fiber = await ctx.plugin(toolSubagent, { provider: 'fake' })
      expect(ctx.tools.list().map((t) => t.name)).toEqual(['subagent'])

      await fiber.dispose()

      expect(ctx.tools.list()).toEqual([])
      expect(ctx.tools.get('subagent')).toBeUndefined()
    } finally {
      await dispose()
    }
  })
})
