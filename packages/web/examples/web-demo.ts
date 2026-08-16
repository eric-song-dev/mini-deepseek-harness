/**
 * M4 演示：零 key 的 Web 体验 —— 假 LLM 台词本（一次 bash 工具往返 + 流式最终回答）
 * 驱动真 HTTP+WS host + 浏览器页面。
 *
 * runtime 组装已抽到 `web-demo-shared.ts`（与 demo:web:real 共用）——这里只负责
 * CLI 参数与启动横幅。想换真模型看 `pnpm demo:web:real`。
 *
 * 用法：pnpm demo:web [--port 8080] [--static apps/web/dist] [--dir .mini-dsh/web-sessions] [--clean]
 *   --port    监听端口（默认 8080）
 *   --static  静态文件目录（默认 apps/web/dist，先由 demo:web 的 build:web 产出）
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
    console.error(`静态文件目录不存在：${staticDir}\n请先运行 pnpm build:web（demo:web 会先构建，直接跑 pnpm demo:web 即可）`)
    process.exit(1)
  }
  if (clean) await rm(sessionsDir, { recursive: true, force: true })
  await mkdir(sessionsDir, { recursive: true })

  const { handle } = await createWebDemoRuntime({ llm: 'fake', port, sessionsDir, staticDir })
  console.log('========================================')
  console.log(`mini-deepseek-harness M4 演示已启动：${handle.url}`)
  console.log('在浏览器打开 → 点「＋ 新建会话」→ 随便说一句话（比如：你好）')
  console.log('→ 看流式消息逐字出现 + 工具卡片随事件弹出')
  console.log('（假 LLM 驱动，零 API key；想用真模型见 pnpm demo:web:real；Ctrl+C 退出）')
  console.log(`会话落盘：${sessionsDir}`)
  console.log('========================================')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
