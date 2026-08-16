/**
 * demo:web:fake：零 key 的 Web 体验 —— 假 LLM 台词本（第一轮 subagent 委派场景 +
 * 第二轮外部 MCP 工具调用 + bash 工具往返 + 流式最终回答）驱动真 HTTP+WS host +
 * 浏览器页面。
 *
 * runtime 组装已抽到 `web-demo-shared.ts`（与 demo:web 共用）——这里只负责
 * CLI 参数与启动横幅。想用真模型看 `pnpm demo:web`。
 *
 * 用法：pnpm demo:web:fake [--port 8080] [--static apps/web/dist] [--dir .mini-dsh/web-sessions] [--clean]
 *   --port    监听端口（默认 8080）
 *   --static  静态文件目录（默认 apps/web/dist，先由 demo:web:fake 的 build:web 产出）
 *   --dir     会话目录（默认 ./.mini-dsh/web-sessions）
 *   --clean   先清空会话目录
 */
import { stat, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createWebDemoRuntime } from './web-demo-shared'

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
    console.error(`静态文件目录不存在：${staticDir}\n请先运行 pnpm build:web（demo:web:fake 会先构建，直接跑 pnpm demo:web:fake 即可）`)
    process.exit(1)
  }
  if (clean) await rm(sessionsDir, { recursive: true, force: true })
  await mkdir(sessionsDir, { recursive: true })

  const { handle } = await createWebDemoRuntime({ llm: 'fake', port, sessionsDir, staticDir })
  console.log('========================================')
  console.log(`mini-deepseek-harness M4/M8/M9 演示已启动：${handle.url}`)
  console.log('在浏览器打开 → 点「＋ 新建会话」→ 随便说一句话（比如：你好）')
  console.log('→ 第一轮：父 agent 调 subagent 工具派生子 agent（tool 卡片 + 会话列表出现子会话，')
  console.log('  点开子会话可看它的独立轨迹回放）')
  console.log('→ 第二轮：调外部 MCP server 的 mcp__fixture__add（真 stdio 协议，tool 卡片可见）')
  console.log('→ 其后每轮：bash 工具卡片 + 流式消息逐字出现')
  console.log('（假 LLM 驱动，零 API key；想用真模型见 pnpm demo:web；Ctrl+C 退出）')
  console.log(`会话落盘：${sessionsDir}`)
  console.log('========================================')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
