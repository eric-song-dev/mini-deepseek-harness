import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadProfile } from '@mini-dsh/kernel'
import { agentLoop } from '@mini-dsh/agent'
import { provideLlm } from '@mini-dsh/llm'
import { openSession, projectTurns } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import type { FakeLlmReply } from '@mini-dsh/test-support'
import { toolRegistry } from '@mini-dsh/tools'
import { fakeWebSearch, webRuntime, webSearchTool } from '../src/index'
import type { WebSearchResult } from '../src/index'

/**
 * 零 key 端到端（T6）：真插件链（tools 注册表 + web seam + 假提供方 + 消费方工具）
 * + 假 LLM 台词本 + 真 agent loop——web_search 全链路入轨迹、可回放；
 * 卸载提供方 → 工具调用得 {error}（稳定注册，不炸轮）→ 重装恢复；
 * profile.yml 加插件行即获 web_search（loadProfile 验收）。
 */

const canned: WebSearchResult = {
  content: '假答案',
  sources: [{ url: 'https://a.example', title: 'A 站', snippet: '摘录' }],
  truncated: false,
}

const searchCall: FakeLlmReply = {
  toolCalls: [{ id: 'w1', name: 'web_search', arguments: { query: 'mini-deepseek-harness' } }],
}
const finalAnswer: FakeLlmReply = { content: '查到了：答案来自假提供方。' }

/** 组装真插件链的最小 harness（loop 全仓唯一具体循环逻辑，一行不改）。 */
async function makeHarness(replies: FakeLlmReply[]) {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(provideLlm, createFakeLlm({ replies }))
  await ctx.plugin(toolRegistry)
  await ctx.plugin(webRuntime)
  const providerFiber = await ctx.plugin(fakeWebSearch, { results: [canned] })
  await ctx.plugin(webSearchTool)
  const session = await openSession(ctx, { id: 'ws1', meta: { id: 'ws1', title: '', createdAt: 0 } })
  const loopFiber = await session.ctx.plugin(agentLoop)
  return { ctx, session, loop: loopFiber.ctx['agent-loop'], providerFiber, dispose }
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('web_search 零 key 端到端（M10）', () => {
  it('假 LLM 台词本驱动 web_search：工具调用与结构化结果入日志，轨迹可回放', async () => {
    const { session, loop, dispose } = await makeHarness([searchCall, finalAnswer])
    try {
      await loop.chat('帮我搜一下 mini-deepseek-harness')
      const events = session.log
      // 轮内事件序列：user → assistant(要工具) → tool(调用) → tool(结果) → assistant(终答) → turn/end(done)
      expect(types(events).slice(-7)).toEqual([
        'turn/start', 'user', 'assistant', 'tool', 'tool', 'assistant', 'turn/end',
      ])
      const callEvent = events.at(-4)!
      expect(callEvent.type).toBe('tool')
      expect(callEvent.payload).toMatchObject({ name: 'web_search', input: { query: 'mini-deepseek-harness' } })
      const resultEvent = events.at(-3)!
      expect(resultEvent.payload).toMatchObject({ name: 'web_search' })
      expect((resultEvent.payload as { output: unknown }).output).toEqual(canned)
      expect((events.at(-1)!.payload as { reason: string }).reason).toBe('done')

      // 轨迹投影：一轮、工具往返两条 tool 明细、结果载荷原样可回放
      const turns = projectTurns(events)
      expect(turns).toHaveLength(1)
      expect(turns[0]!.userText).toBe('帮我搜一下 mini-deepseek-harness')
      expect(turns[0]!.endReason).toBe('done')
      expect(turns[0]!.events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
      const toolResultRow = turns[0]!.events.find((e) => e.type === 'tool' && 'output' in (e.payload as object))
      expect((toolResultRow!.payload as { output: unknown }).output).toEqual(canned)
    } finally {
      await dispose()
    }
  })

  it('卸载提供方 → 工具仍在、调用得 {error}（不炸轮）；重装恢复', async () => {
    const { ctx, session, loop, providerFiber, dispose } = await makeHarness([
      searchCall, finalAnswer, searchCall, finalAnswer, searchCall, finalAnswer,
    ])
    try {
      await loop.chat('第一轮')
      const okOutput = (session.log.at(-3)!.payload as { output: unknown }).output
      expect(okOutput).toEqual(canned)

      await providerFiber.dispose()
      await loop.chat('第二轮：提供方已卸载')
      const events = session.log
      // 稳定注册：工具执行返回模型可读错误结果，轮正常收尾（不是 crash）
      const errorResult = events.filter((e) => e.type === 'tool' && 'output' in (e.payload as object)).at(-1)!
      expect((errorResult.payload as { output: unknown }).output).toEqual({ error: '没有可用的搜索提供方' })
      expect((events.at(-1)!.payload as { reason: string }).reason).toBe('done')

      // 重装提供方 → 第三轮恢复正常结果（HMR-safety 的端到端形态）
      await ctx.plugin(fakeWebSearch, { results: [canned] })
      await loop.chat('第三轮：提供方已重装')
      const restored = session.log.filter((e) => e.type === 'tool' && 'output' in (e.payload as object)).at(-1)!
      expect((restored.payload as { output: unknown }).output).toEqual(canned)
      expect((session.log.at(-1)!.payload as { reason: string }).reason).toBe('done')
    } finally {
      await dispose()
    }
  })
})

describe('profile 加插件行即获能力', () => {
  it('loadProfile 装载 websearch.profile.yml → tools.list() 出现 web_search，seam 可搜索', async () => {
    const profilePath = fileURLToPath(new URL('../examples/websearch.profile.yml', import.meta.url))
    const { ctx, dispose } = await loadProfile(profilePath)
    try {
      expect(ctx.tools.list().map((t) => t.name)).toContain('web_search')
      const result = await ctx.web.search({ query: '任意问题' })
      expect(result.content).toBeDefined()
      expect(result.sources.length).toBeGreaterThan(0)
    } finally {
      await dispose()
    }
  })
})
