/**
 * M4 演示：零 key 的 Web 体验 —— 假 LLM 台词本（一次 bash 工具往返 + 流式最终回答）
 * 驱动真 HTTP+WS host + 浏览器页面。
 *
 * 用法：pnpm demo:web [--port 8080] [--static apps/web/dist] [--dir .mini-dsh/web-sessions] [--clean]
 *   --port    监听端口（默认 8080）
 *   --static  静态文件目录（默认 apps/web/dist，先由 demo:web 的 build:web 产出）
 *   --dir     会话目录（默认 ./.mini-dsh/web-sessions）
 *   --clean   先清空会话目录
 */
import { stat, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { webHost } from '@mini-dsh/web'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const opt = (name: string, fallback: string): string => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback
}

const sessionsDir = resolve(opt('--dir', '.mini-dsh/web-sessions'))
const staticDir = resolve(opt('--static', 'apps/web/dist'))
const port = Number(opt('--port', '8080'))

async function main(): Promise<void> {
  try {
    const info = await stat(staticDir)
    if (!info.isDirectory()) throw new Error('不是目录')
  } catch {
    console.error(`静态文件目录不存在：${staticDir}\n请先运行 pnpm build:web（demo:web 会先构建，直接跑 pnpm demo:web 即可）`)
    process.exit(1)
  }
  if (clean) await rm(sessionsDir, { recursive: true, force: true })
  await mkdir(sessionsDir, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: sessionsDir })
  await ctx.plugin(SessionManager)
  // 台词本：每一轮 = 第一次调用要工具（bash echo）+ 第二次调用流式给出最终回答。
  // 重复 6 轮，demo 期间可反复对话（用完会 turn/end(crash) 报错，重启 demo 即可）。
  // 改这里的分片与 chunkDelay 就能看"打字机"速度变化（教程练习 2）。
  const toolCallReply = { toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo 你好，我是工具卡片' } }] }
  const streamReply = {
    chunks: ['你好！', '我是迷你', ' DeepSeek Harness 的', '演示助手。', '（这段话是流式分片渲染的）'],
    chunkDelay: 45,
  }
  const script = Array.from({ length: 6 }, () => [toolCallReply, streamReply]).flat()
  await ctx.plugin(provideLlm, createFakeLlm({ replies: script }))
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)

  const fiber = await ctx.plugin(webHost, {
    port,
    staticDir,
    systemPrompt: '你是 mini-deepseek-harness 的演示助手：先调一次工具，再流式给出最终回答。',
    stream: true,
  })
  const handle = fiber.ctx['web-host']
  console.log('========================================')
  console.log(`mini-deepseek-harness M4 演示已启动：${handle.url}`)
  console.log('在浏览器打开 → 点「＋ 新建会话」→ 随便说一句话（比如：你好）')
  console.log('→ 看流式消息逐字出现 + 工具卡片随事件弹出')
  console.log('（假 LLM 驱动，零 API key；Ctrl+C 退出）')
  console.log(`会话落盘：${sessionsDir}`)
  console.log('========================================')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
