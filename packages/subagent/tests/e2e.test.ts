import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, projectTurns, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'
import { spawnProvider, SubagentRuntime, toolSubagent } from '@mini-dsh/subagent'
import { toolWorkflow, WorkflowEngine } from '@mini-dsh/workflow'

/**
 * M8 任务 8：轨迹衔接端到端（零 key）。
 * - 父 agent（假 LLM 台词）调用 subagent 工具 → 子 agent（真 bash）完成任务并回收
 *   结果：父会话只多 tool 调用/结果事件（结果含子会话 id）；子会话 JSONL 独立、
 *   projectTurns 可完整回放（轨迹三件套不缺环）；
 * - workflow 脚本跑通 agent/parallel/pipeline：多个子会话独立落盘、谱系正确；
 * - fatal 错误终止脚本：工具结果 isError、模型看到失败原因后如实报告（不静默成功）。
 */

let dir: string
let workspace: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-m8-e2e-'))
  workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'hello from file', 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Runtime {
  ctx: Context
  fake: ReturnType<typeof createFakeLlm>
  dispose: () => Promise<void>
}

/** 最小 runtime：JSONL + SessionManager + 假 LLM + 真 bash + subagent 全家。 */
async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies'], withWorkflow = false) {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawnProvider)
  await ctx.plugin(toolSubagent)
  if (withWorkflow) {
    await ctx.plugin(WorkflowEngine)
    await ctx.plugin(toolWorkflow)
  }
  return { ctx, fake, dispose: () => ctx.fiber.dispose() } satisfies Runtime
}

async function attachLoop(session: Session): Promise<AgentLoop> {
  const fiber = await session.ctx.plugin(agentLoop)
  return fiber.ctx['agent-loop']
}

describe('M8 轨迹衔接 e2e', () => {
  it('父 agent 派生子 agent（真 bash）完成子任务并回收结果：父 tool 事件含子会话 id，子会话独立可回放', async () => {
    const runtime = await boot([
      // 父#1：调 subagent 工具
      {
        toolCalls: [{
          id: 'd1',
          name: 'subagent',
          arguments: { description: '读文件', prompt: '读取 a.txt 的内容并复述给我' },
        }],
      },
      // 子#1：调 bash 读文件
      { toolCalls: [{ id: 'd2', name: 'bash', arguments: { command: 'cat a.txt' } }] },
      // 子#2：最终回答
      { content: '文件内容是 hello from file' },
      // 父#2：继续对话
      { content: '委派完成' },
    ])
    try {
      const session = await runtime.ctx.get('session-manager')!.create({ title: '父会话', cwd: workspace })
      const loop = await attachLoop(session)
      await loop.chat('帮我读一下 a.txt')
      await session.flush()

      // 父会话只多 tool 调用/结果事件对：结果 = 规范值（含子会话 id），无 subagent/* 污染
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
      const toolResult = session.log[5]!.payload as { name: string; input: unknown; output: { kind: string; runId: string; output: string } }
      expect(toolResult.name).toBe('subagent')
      expect(toolResult.output).toEqual({
        kind: 'foreground',
        runId: toolResult.output.runId,
        output: '文件内容是 hello from file',
      })

      // 子会话独立 JSONL：resume 重放 + projectTurns 完整回放（轨迹三件套）
      const child = await runtime.ctx.get('session-manager')!.resume(toolResult.output.runId)
      expect(child.meta).toMatchObject({ parentSessionId: session.id, depth: 1, cwd: workspace })
      expect(child.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
      const turns = projectTurns(child.log)
      expect(turns).toHaveLength(1)
      expect(turns[0]!.userText).toBe('读取 a.txt 的内容并复述给我')
      // 轮内明细不含 turn/start|end（它们投影为轮的边界字段 startedAt/endedAt）
      expect(turns[0]!.events.map((e) => e.type)).toEqual([
        'user', 'assistant', 'tool', 'tool', 'assistant',
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('workflow 脚本跑通 agent/parallel/pipeline：多个子会话独立落盘、谱系正确、父只多 tool 事件对', async () => {
    const runtime = await boot([
      // 父#1：调 workflow 工具
      {
        toolCalls: [{
          id: 'w1',
          name: 'workflow',
          arguments: {
            meta: { name: 'fan-out', description: '扇出两个子任务' },
            script: 'return parallel([async () => agent("任务甲"), async () => agent("任务乙")])',
          },
        }],
      },
      // 子甲、子乙（回复相同，避免与并发调度顺序耦合）、父收尾
      { content: '子回答' },
      { content: '子回答' },
      { content: '编排完成' },
    ], true)
    try {
      const session = await runtime.ctx.get('session-manager')!.create({ title: '父会话', cwd: workspace })
      const loop = await attachLoop(session)
      await loop.chat('帮我扇出两个子任务')
      await session.flush()

      const toolResult = session.log[5]!.payload as {
        name: string
        output: { runId: string; agentsStarted: number; result: string[] }
      }
      expect(toolResult.name).toBe('workflow')
      expect(toolResult.output).toMatchObject({ agentsStarted: 2, result: ['子回答', '子回答'] })

      // 谱系：父 + 两个子会话，depth=1、parentSessionId 指向父
      const all = await runtime.ctx.get('session-manager')!.list()
      expect(all).toHaveLength(3)
      const children = all.filter((m) => m.id !== session.id)
      for (const meta of children) {
        expect(meta.parentSessionId).toBe(session.id)
        expect(meta.depth).toBe(1)
        // 每个子会话都独立可回放
        const child = await runtime.ctx.get('session-manager')!.resume(meta.id)
        expect(projectTurns(child.log)).toHaveLength(1)
      }

      // workflow/* 观察事件不落父日志
      expect(session.log.filter((e) => e.type.startsWith('workflow/'))).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('fatal 错误终止脚本：工具结果 isError、模型看到失败原因（拼错选项绝不静默成功）', async () => {
    const runtime = await boot([
      {
        toolCalls: [{
          id: 'w2',
          name: 'workflow',
          arguments: {
            meta: { name: 'bad', description: '拼错选项' },
            script: 'return pipeline([1], async () => agent("任务", { typo: true }))',
          },
        }],
      },
      // 模型看到失败原因后的如实报告
      { content: '脚本拼错了选项，这个工作流没有跑起来。' },
    ], true)
    try {
      const session = await runtime.ctx.get('session-manager')!.create({ title: '父会话', cwd: workspace })
      const loop = await attachLoop(session)
      await loop.chat('跑个会拼错的脚本')

      // 父日志：tool 调用 + isError 结果（execute 抛错被 loop 归一化回填，轮次不报废）
      expect(session.log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
      const toolResult = session.log[5]!.payload as { name: string; input: unknown; output: { isError: boolean; content: string } }
      expect(toolResult.name).toBe('workflow')
      expect(toolResult.output.isError).toBe(true)
      expect(toolResult.output.content).toContain('UNSUPPORTED_OPTION')
      // 模型第二次调用看到了失败原因（错误结果回填 messages）——绝不静默成功
      expect(JSON.stringify(runtime.fake.requests[1]!.messages)).toContain('UNSUPPORTED_OPTION')
      expect(session.log.at(-1)!.payload).toEqual({ reason: 'done' })
    } finally {
      await runtime.dispose()
    }
  })
})
