/**
 * demo:web（post-MVP 增补，2026-08-16 起为默认 Web 演示）：浏览器里的对话用**真模型**。
 *
 * 与 demo:web:fake 共用同一个 runtime（web-demo-shared.ts），唯一区别是
 * `llm: 'real'`（OpenAI 兼容 adapter）——换 provider = 换一行，host/loop/流式/
 * 轨迹零改动（LLM seam 的教学点）。系统提示自动注入当前时间（datedSystemPrompt），
 * 模型知道"今天几号"。
 *
 * key 读取顺序：环境变量 DEEPSEEK_API_KEY > 项目根 .env 文件（gitignored）。
 * 可选：DEEPSEEK_MODEL（默认 deepseek-chat）、DEEPSEEK_BASE_URL（默认
 * api.deepseek.com；指向 Ollama/vLLM 等兼容端点时无需 key）。
 *
 * 用法：pnpm demo:web [--port 8081] [--static apps/web/dist] [--dir <目录>] [--clean]
 */
import { existsSync, readFileSync } from 'node:fs'
import { stat, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createWebDemoRuntime } from './web-demo-shared'
import type { WebDemoRuntimeOptions } from './web-demo-shared'

// ---- 极简 .env 加载（教学版不引 dotenv 依赖；已设置的环境变量优先）----
const envFile = resolve('.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^"|"$/g, '')
    }
  }
}

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const opt = (name: string, fallback: string): string => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback
}

const sessionsDir = resolve(opt('--dir', '.mini-dsh/web-real-sessions'))
const staticDir = resolve(opt('--static', 'apps/web/dist'))
const port = Number(opt('--port', '8081'))

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error(
      '缺少 DeepSeek API key。两种提供方式任选：\n' +
        '  1) 项目根建 .env（已被 .gitignore 保护）：DEEPSEEK_API_KEY=sk-...\n' +
        '  2) 环境变量：export DEEPSEEK_API_KEY=sk-...\n' +
        '提示：不要把 key 贴进聊天/代码/提交里。',
    )
    process.exit(1)
  }
  try {
    const info = await stat(staticDir)
    if (!info.isDirectory()) throw new Error('不是目录')
  } catch {
    console.error(`静态文件目录不存在：${staticDir}\n请先运行 pnpm build:web（demo:web 会先构建，直接跑 pnpm demo:web 即可）`)
    process.exit(1)
  }
  if (clean) await rm(sessionsDir, { recursive: true, force: true })
  await mkdir(sessionsDir, { recursive: true })

  const runtimeOptions: WebDemoRuntimeOptions = { llm: 'real', apiKey, port, sessionsDir, staticDir }
  if (process.env.DEEPSEEK_BASE_URL !== undefined) runtimeOptions.baseUrl = process.env.DEEPSEEK_BASE_URL
  if (process.env.DEEPSEEK_MODEL !== undefined) runtimeOptions.model = process.env.DEEPSEEK_MODEL
  const { handle } = await createWebDemoRuntime(runtimeOptions)
  console.log('========================================')
  console.log(`mini-deepseek-harness 真模型演示已启动：${handle.url}`)
  console.log(`（model: ${process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'}，`)
  console.log(` endpoint: ${process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}）`)
  console.log('在浏览器打开 → 点「＋ 新建会话」→ 随便问（比如：今年是哪一年）')
  console.log('→ 真模型流式回答 + 轨迹面板回放；系统提示已注入当前时间')
  console.log('→ M8 多智能体（模型可用 bash/subagent/workflow 工具）：')
  console.log('  试"请用 subagent 工具派一个子代理，让它用 bash 执行 date 和 pwd')
  console.log('  并汇报结果"——tool 卡片 + 会话列表出现子会话（点开可回放子轨迹）')
  console.log('→ M9 外部 MCP 工具（mcp__fixture__* 已接入本演示）：')
  console.log('  试"用 add 工具算 2+3"——外部 server 的工具卡片与本地工具同形态')
  console.log(`会话落盘：${sessionsDir}（Ctrl+C 退出）`)
  console.log('========================================')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
