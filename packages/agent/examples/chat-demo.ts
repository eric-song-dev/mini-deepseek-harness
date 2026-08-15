/**
 * M2 演示：agent loop 驱动会话 —— 假 LLM 台词本，零 API key。
 * 三幕：①聊一轮（看日志与"模型看到的 messages"）②同进程再来一轮（看历史累积）
 * ③模拟重启 resume 继续聊（新台词本，历史完整）。
 *
 * 用法：pnpm demo:agent [--dir <目录>] [--clean]
 *   --dir <目录>  会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean       先清空目录再演示（方便反复跑）
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { createToolRegistry, provideTools } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

function renderMessages(messages: readonly { role: string; content: string }[]): string {
  return messages.map((m) => `  [${m.role.padEnd(9)}] ${m.content}`).join('\n')
}

/** 启动一套最小 runtime：JSONL 后端 + SessionManager + 假 LLM（模拟一次"进程启动"）。 */
async function boot(script: string[], systemPrompt: string) {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies: script.map((content) => ({ content })) })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(provideTools, createToolRegistry())
  return {
    ctx,
    manager: ctx.get('session-manager')!,
    fake,
    systemPrompt,
    stop: () => ctx.fiber.dispose(),
  }
}

/** 给会话装上 agent loop（loop 是插件，跑在会话 ctx 上；句柄在插件自己的 ctx）。 */
async function attachLoop(session: Session, systemPrompt: string): Promise<AgentLoop> {
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt })
  return fiber.ctx['agent-loop']
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  // ---- 第一段：聊两轮，看日志与模型输入 ----
  let runtime = await boot(['你好呀！我是这台机器上的教学助手。', '当然记得，我们刚聊过。'], '你是一位耐心的教学助手，回答简短。')
  const s1 = await runtime.manager.create({ title: 'M2 演示会话' })
  const loop1 = await attachLoop(s1, runtime.systemPrompt)

  console.log('===== 第一轮：loop 驱动（turn/start → user → 模型 → assistant → turn/end）=====')
  await loop1.chat('你好')
  await s1.flush()
  console.log(`${render(s1.log)}\n`)
  console.log(`模型看到的 messages：\n${renderMessages(runtime.fake.requests[0]!.messages)}\n`)

  console.log('===== 第二轮：同一进程，历史累积（输入来自日志投影）=====')
  await loop1.chat('你还记得我吗？')
  await s1.flush()
  console.log(`${render(s1.log)}\n`)
  console.log(`模型看到的 messages：\n${renderMessages(runtime.fake.requests[1]!.messages)}\n`)
  const id = s1.id
  await runtime.stop() // 模拟进程退出

  // ---- 第二段：重启（新 ctx = 新进程），resume 继续 ----
  console.log('===== 重启后 resume：新进程、新台词本，历史完整、可继续 =====')
  runtime = await boot(['当然记得！历史我都从日志里读回来了。'], '你是一位耐心的教学助手，回答简短。')
  const s2 = await runtime.manager.resume(id)
  const loop2 = await attachLoop(s2, runtime.systemPrompt)
  await loop2.chat('重启后，你还记得我吗？')
  await s2.flush()
  console.log(`${render(s2.log)}\n`)
  console.log(`模型看到的 messages（全量历史 + 新问题）：\n${renderMessages(runtime.fake.requests[0]!.messages)}\n`)

  console.log(`会话目录：${dir}`)
  console.log(`会话列表：${(await runtime.manager.list()).map((m) => `${m.id} 「${m.title}」`).join('、')}`)
  await runtime.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
