/**
 * M5 演示：轨迹回放 + skill 自举 —— 零 API key（假 LLM 台词驱动）。
 *
 * 第一幕 轨迹回放：一轮 M4 台词（工具往返 + 流式分片）跑完，用 projectTurns 回放
 *   轨迹（按轮分组的事件表 + 检查器视角的配对/用量）；
 * 第二幕 skill 自举：假 LLM 台词驱动 skill 工具（list → get tdd），模型拿到
 *   仓库自己的 .agents/skills/tdd/SKILL.md 全文 —— 教学系统"教自己"。
 *
 * 用法：pnpm demo:trajectory [--dir <会话目录>] [--clean]
 *   --dir   会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean 先清空会话目录再演示（方便反复跑）
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { jsonlPersistence, projectTurns, SessionManager } from '@mini-dsh/session'
import type { ProjectedTurnEvent, Session, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { skillsFromDirectory, skillTool } from '@mini-dsh/skill'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

/** 仓库自己的 skills 目录（自举素材）。 */
const SKILLS_DIR = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))

function summarize(event: ProjectedTurnEvent): string {
  if (event.type === 'user') return (event.payload as { content: string }).content
  if (event.type === 'assistant') {
    const payload = event.payload as { content: string; usage?: { inputTokens: number; outputTokens: number } }
    const usage = payload.usage ? `（输入 ${payload.usage.inputTokens} · 输出 ${payload.usage.outputTokens} tokens）` : '（旧日志无 usage）'
    return `${payload.content || '（要工具）'} ${usage}`
  }
  if (event.type === 'assistant/stream') {
    const summary = event.payload as { chunks: string[]; joined: string }
    return `分片聚合 ×${summary.chunks.length}：${summary.chunks.map((c) => `「${c}」`).join(' ')} = 「${summary.joined}」`
  }
  const tool = event.payload as { name: string; input: unknown; output?: unknown }
  return tool.output === undefined
    ? `${tool.name} 调用 input=${JSON.stringify(tool.input)}`
    : `${tool.name} 结果 output=${JSON.stringify(tool.output)}`
}

/** 按轮打印轨迹回放（检查器视角的关键信息：类型/耗时/载荷摘要）。 */
function renderTrajectory(events: readonly SessionEvent[]): string {
  const turns = projectTurns(events)
  if (turns.length === 0) return '（还没有轮次）'
  return turns
    .map((turn) => {
      const header = `轮 #${turn.index}「${turn.userText ?? '—'}」· ${turn.events.length} 个事件 · 耗时 ${turn.durationMs}ms · 收尾 ${turn.endReason}`
      const detail = turn.events
        .map((event) => `      #${String(event.seq).padStart(2)} ${event.type.padEnd(17)} +${String(event.durationMs).padStart(4)}ms  ${summarize(event)}`)
        .join('\n')
      return `  ${header}\n${detail}`
    })
    .join('\n')
}

/** 第一幕：一轮 M4 台词 → projectTurns 回放。 */
async function act1(): Promise<void> {
  console.log('===== 第一幕：轨迹回放（Trajectory 是灵魂）=====\n')
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  // 台词：要 echo 工具 → 流式最终回答（与 M4 的 e2e 台词同款）
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
      { chunks: ['你', '好', '呀'], chunkDelay: 30 },
    ],
  })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  ctx.get('tools')!.register({
    declaration: {
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    execute: async (input: Record<string, unknown>) => ({ echoed: input.text }),
  })

  const manager = ctx.get('session-manager')!
  const session = await manager.create({ title: 'M5 轨迹演示' })
  const fiber = await session.ctx.plugin(agentLoop, { stream: true })
  const loop: AgentLoop = fiber.ctx['agent-loop']
  await loop.chat('帮我回显「喂」')
  await session.flush()

  console.log('一段对话 = 一串 append-only 事件（日志真源）：')
  console.log(
    session.log
      .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(17)} ${JSON.stringify(e.payload ?? '')}`)
      .join('\n'),
  )
  console.log('\nprojectTurns 投影 = 按轮分组的事件表（轮号 / 用户消息 / 事件数 / 耗时）：')
  console.log(`${renderTrajectory(session.log)}\n`)

  console.log('检查器视角：点选 tool 调用事件 → 配对的结果在同一个往返里（耗时 = 两条事件的 ts 差）；')
  console.log('点选 assistant 终事件 → 看到 token 用量（M5 起 loop 把 llm 返回的 usage 写进日志）。\n')
  await ctx.fiber.dispose()
}

/** 第二幕：skill 自举 —— 假 LLM 台词驱动 skill 工具加载仓库自己的 TDD skill。 */
async function act2(): Promise<void> {
  console.log('===== 第二幕：skill 自举（mini 版加载并运行自己的 TDD skill）=====\n')
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  // 台词：先 list 看有什么技能 → get tdd 取全文 → 按 TDD 纪律说话
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'list' } }] },
      { toolCalls: [{ id: 's2', name: 'skill', arguments: { action: 'get', name: 'tdd' } }] },
      { content: '好，我按 TDD 纪律来：先写一个失败的测试。' },
    ],
  })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(skillsFromDirectory, { dir: SKILLS_DIR })
  await ctx.plugin(skillTool)

  const manager = ctx.get('session-manager')!
  const session: Session = await manager.create({ title: 'M5 skill 自举' })
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是一个 AI 编程助手。' })
  const loop: AgentLoop = fiber.ctx['agent-loop']
  await loop.chat('加载 TDD 技能，并按它说话')
  await session.flush()

  console.log(`skills 来自真实文件系统：${SKILLS_DIR}（目录名即技能名，SKILL.md 即正文）`)
  console.log(`模型第一步问「有哪些技能」→ 工具返回：${JSON.stringify(ctx.get('skills')!.list())}\n`)
  console.log('模型三次调用看到的工具声明：', JSON.stringify(fake.requests.map((r) => r.tools.map((t) => t.name))))
  const bodyMessage = fake.requests[2]!.messages.find(
    (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'tdd',
  )
  if (!bodyMessage) throw new Error('演示断言失败：模型第二次工具往返后没有收到 tdd 技能全文')
  const { name, content } = JSON.parse(bodyMessage.content) as { name: string; content: string }
  console.log(`\n模型收到的技能全文 == 磁盘文件正文（${name}，${content.length} 字符），开头：`)
  console.log(`${content.split('\n').slice(0, 6).map((line) => `  ${line}`).join('\n')}`)
  console.log('  …')
  console.log('\n最终回答（技能内容真的进了上下文）：')
  const lastAssistant = session.log.filter((e) => e.type === 'assistant').at(-1)!
  console.log(`  ${(lastAssistant.payload as { content: string }).content}\n`)
  await ctx.fiber.dispose()
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await act1()
  await act2()
  console.log(`会话目录：${dir}（${'<id>'}.jsonl 里是完整事件日志）`)
  console.log('浏览器视角：pnpm demo:web 后发一轮消息，底部「轨迹」面板可以点选回放每一步。')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
