/**
 * M9 演示：外部 MCP server 的工具变成本地 Tools 注册表的一员 —— 零 API key。
 *
 * 三幕：
 *   1. tools.list()：外部 server 的工具以 mcp__<serverName>__<rawName> 现身；
 *   2. 假 LLM 台词本驱动**真 MCP 调用**（真协议真子进程），全程落轨迹；
 *   3. crash 工具杀掉 server 进程 → 断开即撤销（工具消失）→ 重新装载恢复。
 *
 * 用法：pnpm demo:mcp [--dir <会话目录>] [--clean]
 *   --dir    会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean  先清空会话目录再演示（方便反复跑）
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { agentLoop } from '@mini-dsh/agent'
import { mcpClient } from '@mini-dsh/mcp'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

const fixtureServerPath = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url))

const MCP_CONFIG = {
  serverName: 'fixture',
  transport: 'stdio',
  command: process.execPath,
  args: [fixtureServerPath],
} as const

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

function mcpNames(ctx: Context): string[] {
  return ctx.tools.list().map((d) => d.name).filter((n) => n.startsWith('mcp__'))
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`等待超时：${what}`)
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(toolRegistry)
  // 一行插件 + 一段配置 = 接入一个外部 MCP server（"一切皆为插件"）。
  // loop 完全不知道这些工具来自外部——它只认 tools 注册表。
  const firstMount = await ctx.plugin(mcpClient, MCP_CONFIG)

  console.log('===== 第一幕：外部 server 的工具出现在本地注册表 =====')
  console.log(`启动 stdio MCP server：node ${fixtureServerPath}`)
  console.log(`tools.list() 里的 mcp 工具：${JSON.stringify(mcpNames(ctx))}`)
  console.log(`（raw 名 add/greet/... 绝不注册；模型看到的是 mcp__fixture__*）\n`)

  // 假 LLM 台词本：先要 mcp__fixture__add，再给最终总结（两轮 chat、一次工具往返）
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 'c1', name: 'mcp__fixture__add', arguments: { a: 2, b: 3 } }] },
      { content: '我调了外部 MCP server 的 add 工具，2 + 3 = 5。' },
    ],
  })
  await ctx.plugin(provideLlm, fake)

  console.log('===== 第二幕：模型调用外部工具（真协议、真子进程）=====')
  const session = await (ctx.get('session-manager')!.create({ title: 'M9 MCP 演示会话' }))
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是演示助手：先调一次工具，再总结。' })
  await fiber.ctx['agent-loop'].chat('帮我算 2 + 3，用 add 工具')
  await session.flush()
  console.log(`${render(session.log)}\n`)
  console.log(`模型第二次调用看到的工具结果已回填：${JSON.stringify(fake.requests[1]!.messages.at(-1)?.content)}\n`)

  console.log('===== 第三幕：server 崩溃 → 断开即撤销 → 重新装载恢复 =====')
  console.log('调用 crash 工具（server 回复后退出进程）……')
  const crashResult = await ctx.tools.execute('mcp__fixture__crash', {}, { cwd: process.cwd() })
  console.log(`crash 的结果先正常返回：${JSON.stringify(crashResult)}`)
  await waitUntil(() => mcpNames(ctx).length === 0, '断开后工具撤销')
  console.log('断开即撤销：tools.list() 里已没有 mcp 工具（死工具不残留）')
  console.log('重连 = 卸载旧实例（释放 serverName 预留）→ 重新装载同配置：')
  await firstMount.dispose()
  await ctx.plugin(mcpClient, MCP_CONFIG)
  await waitUntil(() => mcpNames(ctx).length > 0, '重新装载后工具恢复')
  console.log(`工具回来了（${JSON.stringify(mcpNames(ctx))}）——公开名是纯函数，名字完全相同`)
  console.log('（"可重连重注册" = dispose 后重新装载；自动重连监督器是裁剪项）')

  console.log(`\n会话目录：${dir}（jsonl 里是完整事件日志——Trajectory 的素材）`)
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
