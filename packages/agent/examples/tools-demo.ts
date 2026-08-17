/**
 * M3 演示：工具调用循环 —— 假 LLM 台词本驱动**真工具**，零 API key。
 * 剧本：模型"读文件 → 改文件 → 总结"，每个动作都落会话日志（tool 调用/结果对）。
 *
 * 用法：pnpm demo:tools [--dir <会话目录>] [--workdir <工作目录>] [--clean]
 *   --dir     会话文件目录（默认 ./.mini-dsh/sessions）
 *   --workdir 工具工作目录（默认 ./.mini-dsh/workspace，会自动创建并放一个 notes.txt）
 *   --clean   先清空两个目录再演示（方便反复跑）
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, editFileTool, readFileTool, toolRegistry, writeFileTool } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const workdirIndex = args.indexOf('--workdir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')
const workdir =
  workdirIndex >= 0 && args[workdirIndex + 1] ? resolve(args[workdirIndex + 1]!) : resolve('.mini-dsh', 'workspace')

const NOTES_PATH = resolve(workdir, 'notes.txt')
const NOTES_SEED = 'M3 演示笔记：状态 = 未完成\n剩下的交给模型来改。\n'

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

function renderMessages(messages: readonly { role: string; content: string; toolCalls?: unknown; toolCallId?: string }[]): string {
  return messages
    .map((m) => {
      const extra = m.toolCallId !== undefined ? `（回填调用 ${m.toolCallId}）` : ''
      const calls = m.toolCalls !== undefined ? ` 工具调用=${JSON.stringify(m.toolCalls)}` : ''
      return `  [${m.role.padEnd(9)}] ${m.content}${extra}${calls}`
    })
    .join('\n')
}

/** 启动一套最小 runtime：JSONL 后端 + SessionManager + 假 LLM + 四个真工具。 */
async function boot() {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  // 台词本：要 read → 要 edit → 最终总结（三次 llm.chat，两次工具往返）
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'notes.txt' } }] },
      { toolCalls: [{ id: 'c2', name: 'edit', arguments: { file_path: 'notes.txt', old_string: '未完成', new_string: '已完成' } }] },
      { content: '好，我把 notes.txt 里的「未完成」改成了「已完成」。' },
    ],
  })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)
  await ctx.plugin(readFileTool)
  await ctx.plugin(writeFileTool)
  await ctx.plugin(editFileTool)
  return { ctx, manager: ctx.get('session-manager')!, fake, stop: () => ctx.fiber.dispose() }
}

async function attachLoop(session: Session, cwd: string): Promise<AgentLoop> {
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是文件助手，用工具动手改文件，最后用一句话总结。' })
  return fiber.ctx['agent-loop']
}

async function main(): Promise<void> {
  if (clean) {
    await rm(dir, { recursive: true, force: true })
    await rm(workdir, { recursive: true, force: true })
  }
  await mkdir(dir, { recursive: true })
  await mkdir(workdir, { recursive: true })
  try {
    await readFile(NOTES_PATH, 'utf8')
  } catch {
    await writeFile(NOTES_PATH, NOTES_SEED, 'utf8')
  }

  const runtime = await boot()
  const session = await runtime.manager.create({ title: 'M3 演示会话', cwd: workdir })
  const loop = await attachLoop(session, workdir)

  console.log('===== 开始前：工作目录里的 notes.txt =====')
  console.log(`${await readFile(NOTES_PATH, 'utf8')}`)
  console.log('（工具声明给了模型：read / write / edit / bash）\n')

  console.log('===== 一轮工具循环：读 → 改 → 总结 =====')
  await loop.chat('帮我把 notes.txt 的状态改成已完成')
  await session.flush()
  console.log(`${render(session.log)}\n`)

  console.log('===== 模型三次调用分别看到了什么 =====')
  console.log('第 1 次（只要了工具）：')
  console.log(`${renderMessages(runtime.fake.requests[0]!.messages)}\n`)
  console.log('第 2 次（上一步工具结果已回填 messages）：')
  console.log(`${renderMessages(runtime.fake.requests[1]!.messages)}\n`)
  console.log('第 3 次（两次工具往返都在历史里，模型给出最终回答）：')
  console.log(`${renderMessages(runtime.fake.requests[2]!.messages)}\n`)

  console.log('===== 结束后：文件真的被改了（真工具，不是装样子）=====')
  console.log(`${await readFile(NOTES_PATH, 'utf8')}`)

  console.log(`会话目录：${dir}（${session.id}.jsonl 里是完整事件日志——这就是 Trajectory 的素材）`)
  await runtime.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
