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
import { SubagentRuntime } from '@mini-dsh/subagent'
import type { SubagentProvider, SubagentRun } from '@mini-dsh/subagent'
import { toolWorkflow, WorkflowEngine } from '@mini-dsh/workflow'

/**
 * M8 任务 7：tool-workflow —— 面向模型的 `workflow` 工具：运行一段扇出 subagent
 * 的 JS 编排脚本并返回脚本最终值。schema 与运行生命周期归工具，解析/执行/上限/
 * 取消在 seam 之后（engine）。
 *
 * 契约主题（上游 tool-workflow 的 mini 版）：
 * - 参数：meta（必填身份块）+ script（必填脚本体）+ args（可选 JSON 对象）；
 *   description 即脚本编写契约全文；
 * - 同步收集：execute 启动 run、等待 result、try/finally 总是 dispose；
 * - 非 completed → isError（报告原因，不把部分输出当成功）；
 * - 无 agent 上下文 → 抛错（没有可归属的父会话）；
 * - 完成返回规范值 { runId, agentsStarted, result }。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-tool-workflow-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 假提供方：记录 dispose（"工具总是 dispose"的可观测性）。 */
function makeProvider(): { provider: SubagentProvider; disposed: number } {
  let disposed = 0
  const provider: SubagentProvider = {
    name: 'fake',
    inheritsParentContext: false,
    async start() {
      const run: SubagentRun = {
        id: 'child-1',
        result: Promise.resolve({ output: '子 agent 的回答', stopReason: 'completed' }),
        dispose: async () => { disposed++ },
      }
      return run
    },
  }
  return { provider, get disposed() { return disposed } }
}

async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies'] = []) {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(WorkflowEngine, { provider: 'fake' })
  return { ctx, fake, dispose }
}

async function openSession(ctx: Context): Promise<{ session: Session; loop: AgentLoop }> {
  const session = await ctx.get('session-manager')!.create({ title: '父会话' })
  const fiber = await session.ctx.plugin(agentLoop)
  return { session, loop: fiber.ctx['agent-loop'] }
}

describe('tool-workflow（M8 任务 7）', () => {
  it('注册 `workflow` 工具：description 即脚本编写契约全文（meta 块 + 五钩子语义 + 约束）', async () => {
    const { ctx, dispose } = await boot()
    try {
      await ctx.plugin(toolWorkflow)
      const declaration = ctx.tools.get('workflow')!.declaration
      expect(declaration.description).toContain('agent(prompt')
      expect(declaration.description).toContain('parallel(')
      expect(declaration.description).toContain('pipeline(')
      expect(declaration.description).toContain('phase(')
      expect(declaration.description).toContain('meta')
      expect(declaration.description).toContain('args')
    } finally {
      await dispose()
    }
  })

  it('execute：completed → 规范值 { runId, agentsStarted, result }；args 逐字进脚本；总是 dispose', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider()
      ctx.subagents.registerProvider(fake.provider)
      await ctx.plugin(toolWorkflow)
      const { session } = await openSession(ctx)

      const output = await ctx.tools.execute(
        'workflow',
        {
          meta: { name: 'audit', description: '审查' },
          script: 'return await agent(args.task)',
          args: { task: '审查这批文件' },
        },
        { cwd: process.cwd(), agent: session.ctx },
      )
      expect(output).toMatchObject({ agentsStarted: 1, result: '子 agent 的回答' })
      expect((output as { runId: string }).runId).toBeTruthy()
      expect(fake.disposed).toBe(1) // try/finally：每条路径都 dispose

      // 观察事件进了父会话隔离总线（不落父日志）
      expect(session.log).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('非 completed → isError：cancelled 与 error 各给明确消息（不把部分输出当成功）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const failing: SubagentProvider = {
        name: 'fake',
        inheritsParentContext: false,
        async start() {
          throw new Error('起不来')
        },
      }
      ctx.subagents.registerProvider(failing)
      await ctx.plugin(toolWorkflow)
      const { session } = await openSession(ctx)

      await expect(
        ctx.tools.execute(
          'workflow',
          { meta: { name: 'audit', description: '审查' }, script: 'return await agent("任务")' },
          { cwd: process.cwd(), agent: session.ctx },
        ),
      ).rejects.toThrow(/workflow run failed[\s\S]*AGENT_START/)

      // 脚本抛普通错 → error
      await expect(
        ctx.tools.execute(
          'workflow',
          { meta: { name: 'audit', description: '审查' }, script: 'throw new Error("脚本炸了")' },
          { cwd: process.cwd(), agent: session.ctx },
        ),
      ).rejects.toThrow(/workflow run failed[\s\S]*脚本炸了/)
    } finally {
      await dispose()
    }
  })

  it('无 agent 上下文（loop 之外直接 execute）→ 抛错：没有可归属的父会话', async () => {
    const { ctx, dispose } = await boot()
    try {
      await ctx.plugin(toolWorkflow)
      await expect(
        ctx.tools.execute(
          'workflow',
          { meta: { name: 'audit', description: '审查' }, script: 'return 1' },
          { cwd: process.cwd() },
        ),
      ).rejects.toThrow(/agent/)
    } finally {
      await dispose()
    }
  })

  it('集成：loop 台词驱动 workflow 工具——父只多 tool 事件对（结果含 runId/agentsStarted/result）', async () => {
    const { ctx, fake, dispose } = await boot([
      {
        toolCalls: [{
          id: 'w1',
          name: 'workflow',
          arguments: {
            meta: { name: 'fan-out', description: '扇出审查' },
            script: 'return parallel([async () => agent("审查 a"), async () => agent("审查 b")])',
          },
        }],
      },
      { content: '编排完成' },
    ])
    try {
      const fakeProvider = makeProvider()
      ctx.subagents.registerProvider(fakeProvider.provider)
      await ctx.plugin(toolWorkflow)
      const { session, loop } = await openSession(ctx)
      await loop.chat('帮我扇出审查')
      await session.flush()

      const toolResult = session.log.find((e) => e.type === 'tool' && (e.payload as { output?: unknown }).output !== undefined)!
      const output = (toolResult.payload as { output: { runId: string; agentsStarted: number; result: string[] } }).output
      expect(output).toMatchObject({ agentsStarted: 2, result: ['子 agent 的回答', '子 agent 的回答'] })
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
      // 父会话只多 tool 事件对：workflow/* 观察事件不落父日志
      expect(session.log.filter((e) => e.type.startsWith('workflow/'))).toEqual([])
      // 父模型的第二问：输入含工具结果（role:tool 回填），编排完成后继续对话
      expect(fake.requests[1]!.messages.at(-1)!.role).toBe('tool')
    } finally {
      await dispose()
    }
  })

  it('HMR-safety：卸载 toolWorkflow 插件 fiber → 工具从注册表消失', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fiber = await ctx.plugin(toolWorkflow)
      expect(ctx.tools.list().map((t) => t.name)).toEqual(['workflow'])

      await fiber.dispose()

      expect(ctx.tools.list()).toEqual([])
      expect(ctx.tools.get('workflow')).toBeUndefined()
    } finally {
      await dispose()
    }
  })
})
