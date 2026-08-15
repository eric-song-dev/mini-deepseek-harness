/**
 * M3 教程练习脚本（docs/tutorials/M3-tools.md §6 步骤 2/3）：
 *
 * 练习任务：
 *   1) 先原样跑一遍：pnpm tsx packages/agent/examples/my-tools.ts
 *   2) 把 SCRIPT 里 edit_file 的 newText 改成别的字，再跑——看磁盘文件与日志怎么变；
 *   3) 照着 CUSTOM_TOOL 注册一个自己的工具（比如把文本反转），把 SCRIPT 的第一段
 *      换成调用你的工具，再跑——看工具循环跑起来。
 *
 * 用法：pnpm tsx packages/agent/examples/my-tools.ts
 *   （工具工作目录 ./.mini-dsh/workspace，会话目录 ./.mini-dsh/sessions）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session, SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import {
  createEditFileTool,
  createReadFileTool,
  createToolRegistry,
  provideTools,
} from '@mini-dsh/tools'
import type { Tool } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

// ↓↓↓ 练习区 1：这段台词本就是"模型的剧本"（两次工具往返 + 最终回答）↓↓↓
const SCRIPT = [
  { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'notes.txt' } }] },
  { toolCalls: [{ id: 'c2', name: 'edit_file', arguments: { path: 'notes.txt', oldText: '未完成', newText: '已完成' } }] },
  { content: '好，我把 notes.txt 里的「未完成」改成了「已完成」。' },
]
// ↑↑↑ 练习区 1 ↑↑↑

// ↓↓↓ 练习区 2：照这个样子注册一个你自己的工具（比如把文本反转），再把上面剧本
//              第一段的 name 换成你的工具名 ↓↓↓
const CUSTOM_TOOL: Tool = {
  declaration: {
    name: 'shout',
    description: '把一段文本变成全大写。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  async execute(input: Record<string, unknown>) {
    const { text } = input as unknown as { text: string }
    return { loud: text.toUpperCase() }
  },
}
// ↑↑↑ 练习区 2 ↑↑↑

const dir = resolve('.mini-dsh', 'sessions')
const workdir = resolve('.mini-dsh', 'workspace')
const NOTES_PATH = resolve(workdir, 'notes.txt')

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

async function main(): Promise<void> {
  await mkdir(dir, { recursive: true })
  await mkdir(workdir, { recursive: true })
  // 练习脚本每次重置种子文件：保证改剧本的练习可复现（demo 是幂等续写，练习是确定性重置）。
  await writeFile(NOTES_PATH, 'M3 练习笔记：状态 = 未完成\n', 'utf8')

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies: SCRIPT })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(provideTools, createToolRegistry())
  const registry = ctx.get('tools')!
  registry.register(CUSTOM_TOOL) // 练习区 2 的工具在这注册；剧本里不用它时不影响
  // 注册两个文件工具（剧本用的）：直接工厂函数拿 Tool，不引插件
  registry.register(createReadFileTool())
  registry.register(createEditFileTool())

  const session: Session = await ctx.get('session-manager')!.create({ title: 'M3 练习', cwd: workdir })
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是文件助手，用工具动手，最后用一句话总结。' })
  const loop = fiber.ctx['agent-loop']

  console.log('===== 一轮工具循环（台词本驱动真工具）=====')
  await loop.chat('帮我把 notes.txt 的状态改成已完成')
  await session.flush()
  console.log(`${render(session.log)}\n`)

  console.log('===== 结束后 notes.txt 的内容 =====')
  console.log(`${await readFile(NOTES_PATH, 'utf8')}`)

  console.log('===== 模型三次调用看到的 messages（注意 tool 结果回填）=====')
  fake.requests.forEach((request, i) => {
    console.log(`第 ${i + 1} 次：`)
    for (const m of request.messages) {
      const tag = m.role === 'tool' ? `（回填调用 ${m.toolCallId}）` : m.toolCalls ? ` 工具调用=${JSON.stringify(m.toolCalls)}` : ''
      console.log(`  [${m.role.padEnd(9)}] ${m.content}${tag}`)
    }
  })

  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
