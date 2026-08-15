/**
 * M2 教程练习脚本：给假 LLM 换台词本，看日志与"模型看到的 messages"怎么变。
 *
 * 练习任务（docs/tutorials/M2-llm-and-loop.md §6 步骤 2/3）：
 *   1) 修改下方 SCRIPT_1 / SCRIPT_2 的台词；
 *   2) 运行：pnpm tsx packages/agent/examples/my-script.ts
 *   3) 观察输出：assistant 事件内容跟着台词变；"重启"后 resume 的那一轮，
 *      模型输入里出现重启前的全部问答（历史来自日志投影，不是内存里的数组）。
 *
 * 用法：pnpm tsx packages/agent/examples/my-script.ts [目录]
 *   默认目录 ./.mini-dsh/sessions
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

// ↓↓↓ 练习：改这两份台词本 ↓↓↓
const SCRIPT_1 = ['第一句台词（第一轮回复）', '第二句台词（第二轮回复）']
const SCRIPT_2 = ['重启后的台词（第三轮回复）']
// ↑↑↑ 练习：改这两份台词本 ↑↑↑

const dir = resolve(process.argv[2] ?? '.mini-dsh/sessions')

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

async function boot(script: string[]) {
  await mkdir(dir, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies: script.map((content) => ({ content })) })
  await ctx.plugin(provideLlm, fake)
  return { ctx, manager: ctx.get('session-manager')!, fake, stop: () => ctx.fiber.dispose() }
}

async function attachLoop(session: Session): Promise<AgentLoop> {
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是教学助手，回答简短。' })
  return fiber.ctx['agent-loop']
}

async function main(): Promise<void> {
  // ---- 第一段进程：聊两轮 ----
  const first = await boot(SCRIPT_1)
  const s1 = await first.manager.create({ title: 'M2 练习' })
  const loop1 = await attachLoop(s1)
  await loop1.chat('第一问')
  await loop1.chat('第二问')
  await s1.flush()
  console.log('===== 第一段进程（聊两轮）=====')
  console.log(`${render(s1.log)}\n`)
  console.log('第二轮模型看到的 messages：')
  for (const m of first.fake.requests[1]!.messages) console.log(`  [${m.role.padEnd(9)}] ${m.content}`)
  console.log()
  const id = s1.id
  await first.stop()

  // ---- 第二段进程：重启，resume 后续聊 ----
  const second = await boot(SCRIPT_2)
  const s2 = await second.manager.resume(id)
  const loop2 = await attachLoop(s2)
  await loop2.chat('第三问')
  await s2.flush()
  console.log('===== 重启后 resume（第三轮）=====')
  console.log(`${render(s2.log)}\n`)
  console.log('第三轮模型看到的 messages（历史来自日志投影）：')
  for (const m of second.fake.requests[0]!.messages) console.log(`  [${m.role.padEnd(9)}] ${m.content}`)
  await second.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
