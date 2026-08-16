import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext, createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import { spawnProvider, SubagentRuntime } from '@mini-dsh/subagent'

/**
 * 【M8 教程练习 1：派一个 subagent 并观察它的生命周期】（零 key，假 LLM 驱动）
 *
 * 你要做的事：不写实现，只补两个断言——
 *   1. 子 agent 的结果（result.output / stopReason）是什么？
 *   2. 父会话 ctx 上的 subagent/start 观察事件里，provider 字段是什么？
 *
 * 红绿翻转（小白验收）：把第 52 行的期望值 'spawn' 改成 'fork'，运行测试看红
 * （观察事件没配对/提供方名不符），再改回来变绿。
 *
 * 运行：pnpm vitest run packages/subagent/tests/my-subagent.test.ts
 * 教程：docs/tutorials/M8-subagent-workflow.md
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-my-subagent-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('我的第一个 subagent（M8 教程练习）', () => {
  it('spawn 一个子 agent：结果回收正确、观察事件在父会话 ctx 上', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(jsonlPersistence, { dir })
    await ctx.plugin(SessionManager)
    // 假 LLM 台词本：唯一的调用是子 agent 的（父会话这里不开轮次）
    await ctx.plugin(provideLlm, createFakeLlm({ replies: [{ content: '练习回答' }] }))
    await ctx.plugin(toolRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider)

    const parent = await ctx.get('session-manager')!.create({ title: '练习父会话' })
    const started: string[] = []
    parent.ctx.on('subagent/start', (info) => { started.push(info.provider) })

    const run = await ctx.subagents.start('spawn', { prompt: '请回答：1+1 等于几？', parent: parent.ctx })
    const result = await run.result
    await run.dispose()

    // —— 练习 1：子 agent 的结果是什么？（先自己写一遍，再对照教程）——
    expect(result).toEqual({ output: '练习回答', stopReason: 'completed' })

    // —— 练习 2：观察事件里的 provider 名是什么？（红绿翻转点在这一行）——
    expect(started).toEqual(['spawn'])

    // 顺手看一眼：子会话是独立日志，父会话没有被污染
    expect(parent.log).toHaveLength(1)
    await dispose()
  })
})
