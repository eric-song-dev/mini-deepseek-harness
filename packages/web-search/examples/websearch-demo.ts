/**
 * M10 演示：web search 能力 seam 三层拆分 —— 零 API key。
 *
 * 三幕：
 *   1. 四行插件（seam + 提供方 + 工具）→ tools.list() 出现 web_search，
 *      唯一可用提供方被自动选中；
 *   2. 假 LLM 台词本驱动**真工具调用**（web_search → ctx.web → fakeWebSearch），
 *      全程落轨迹、结构化结果回填给模型；
 *   3. 卸载提供方插件 → 工具仍在、调用得 {error}（稳定注册，不炸轮）→
 *      重装恢复（HMR-safety 的演示形态）。
 *
 * 用法：pnpm demo:websearch [--dir <会话目录>] [--clean]
 *   --dir    会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean  先清空会话目录再演示（方便反复跑）
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import { fakeWebSearch, webRuntime, webSearchTool } from '@mini-dsh/web-search'
import type { WebSearchResult } from '@mini-dsh/web-search'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

/** 假提供方的固定台词（三幕各消费一条）。 */
const CANNED: WebSearchResult = {
  content: '这是一条假搜索结果：不联网，只用来演示 web_search 全链路。',
  sources: [
    { url: 'https://koishi.chat/guide/plugin/context.html', title: 'Koishi 插件上下文', snippet: 'CORDIS 是 Koishi 的插件内核：服务、事件、组合。' },
    { url: 'https://martinfowler.com/eaaDev/EventSourcing.html', title: 'Event Sourcing（Martin Fowler）', snippet: 'Event sourcing persists the state as a sequence of events.' },
  ],
  truncated: false,
}

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(toolRegistry)
  // 三层拆分（"一切皆为插件"）：能力 seam + 提供方插件 + 消费方工具，三行独立。
  // 换提供方 = 换掉 fakeWebSearch 那一行（如换成 deepseekWebSearch 读真实 API）；
  // loop 与模型侧（web_search 工具）一行不改。
  await ctx.plugin(webRuntime)
  const providerFiber = await ctx.plugin(fakeWebSearch, { results: [CANNED, CANNED, CANNED] })
  await ctx.plugin(webSearchTool)

  console.log('===== 第一幕：四行插件 = web search 能力 =====')
  console.log(`tools.list() 里的工具：${JSON.stringify(ctx.tools.list().map((d) => d.name))}`)
  const direct = await ctx.web.search({ query: 'cordis 插件内核' })
  console.log(`直接调 ctx.web.search：唯一可用提供方被自动选中 → ${direct.sources.length} 条来源`)
  console.log(`（seam 的执行时选择：未配置 id 且恰好一个可用提供方 = fake）\n`)

  // 假 LLM 台词本：三轮都是"先调 web_search、再总结"
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 'w1', name: 'web_search', arguments: { query: 'cordis 插件内核' } }] },
      { content: '第一轮：我调了 web_search 工具，结果由 fakeWebSearch 提供。' },
      { toolCalls: [{ id: 'w2', name: 'web_search', arguments: { query: '事件溯源' } }] },
      { content: '第二轮：这次调用会失败——提供方已被卸载，但工具还在。' },
      { toolCalls: [{ id: 'w3', name: 'web_search', arguments: { query: '事件溯源' } }] },
      { content: '第三轮：提供方重装后恢复正常。' },
    ],
  })
  await ctx.plugin(provideLlm, fake)

  console.log('===== 第二幕：模型调用 web_search（真工具往返，零 key）=====')
  const session = await (ctx.get('session-manager')!.create({ title: 'M10 web search 演示会话' }))
  const loopFiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是演示助手：先调一次 web_search 工具，再总结。' })
  await loopFiber.ctx['agent-loop'].chat('帮我搜一下 cordis 插件内核')
  await session.flush()
  console.log(`${render(session.log)}\n`)
  console.log(`模型第二次调用看到的工具结果已回填：${JSON.stringify(fake.requests[1]!.messages.at(-1)?.content)}\n`)

  console.log('===== 第三幕：卸载提供方 → {error} 结果（稳定注册）→ 重装恢复 =====')
  await providerFiber.dispose()
  await loopFiber.ctx['agent-loop'].chat('再搜一次事件溯源')
  await session.flush()
  const errorRound = session.log.filter((e) => e.type === 'tool' && 'output' in (e.payload as object)).at(-1)!
  console.log(`提供方卸载后工具仍在，模型得到可读错误：${JSON.stringify((errorRound.payload as { output: unknown }).output)}`)
  console.log(`（稳定注册：工具跟随产品启用状态而非后端可用性；轮正常收尾，不是 crash）`)
  await ctx.plugin(fakeWebSearch)
  await loopFiber.ctx['agent-loop'].chat('再搜一次事件溯源')
  await session.flush()
  const restored = session.log.filter((e) => e.type === 'tool' && 'output' in (e.payload as object)).at(-1)!
  console.log(`重装提供方 → 下一轮恢复正常结果：${JSON.stringify((restored.payload as { output: unknown }).output)}`)
  console.log('（HMR-safety 的演示形态：卸载即撤销、重装即恢复）')

  console.log(`\n会话目录：${dir}（jsonl 里是完整事件日志——Trajectory 的素材）`)
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
