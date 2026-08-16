/**
 * 真实 API 演示（需要 DeepSeek API key）：用真模型跑一轮 agent loop（含 M3 工具）。
 *
 * 这是全仓唯一会真的调用外部 LLM API 的脚本——其余测试与 demo 都是零 key 假 LLM。
 * 用途：给你自己/我一条"真链路冒烟"的命令：真 adapter（OpenAI 兼容协议）+ 真 loop +
 * 真工具，一轮对话全量落事件日志（JSONL）。
 *
 * key 读取顺序：环境变量 DEEPSEEK_API_KEY > 项目根 .env 文件（gitignored，绝不入库）。
 * 可选：DEEPSEEK_MODEL（默认 deepseek-chat）、DEEPSEEK_BASE_URL（默认 api.deepseek.com，
 * 可用于 Ollama/vLLM 等兼容端点）。
 *
 * 用法：pnpm demo:real [--ask "问题"] [--dir <目录>] [--clean]
 *   --ask   用户消息（默认"用一句话介绍你自己"）
 *   --dir   会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean 先清空会话目录再演示
 */
import { mkdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { openAiLlm } from '@mini-dsh/llm'
import { bashTool, editFileTool, readFileTool, toolRegistry, writeFileTool } from '@mini-dsh/tools'
import { agentLoop, datedSystemPrompt } from '@mini-dsh/agent'

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

/** 取 key：环境变量 > .env；都没有则干净报错退出（TS 收窄用函数形态）。 */
function requireApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    console.error(
      '缺少 DeepSeek API key。两种提供方式任选：\n' +
        '  1) 项目根建 .env（已被 .gitignore 保护）：DEEPSEEK_API_KEY=sk-...\n' +
        '  2) 环境变量：export DEEPSEEK_API_KEY=sk-...\n' +
        '提示：不要把 key 贴进聊天/代码/提交里。',
    )
    process.exit(1)
  }
  return key
}

const apiKey = requireApiKey()

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const askIndex = args.indexOf('--ask')
const dirIndex = args.indexOf('--dir')
const ask = askIndex >= 0 && args[askIndex + 1] ? args[askIndex + 1]! : '用一句话介绍你自己'
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  // 真 adapter（OpenAI 兼容协议）：DeepSeek 官方 API / Ollama / vLLM 都走它
  await ctx.plugin(openAiLlm, {
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  })
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)
  await ctx.plugin(readFileTool)
  await ctx.plugin(writeFileTool)
  await ctx.plugin(editFileTool)

  const manager = ctx.get('session-manager')!
  const session = await manager.create({ title: `真 API：${ask.slice(0, 20)}`, cwd: process.cwd() })
  const fiber = await session.ctx.plugin(agentLoop, {
    // 注入当前时间（post-MVP）：模型不知道"今天几号"的确定性兜底（工具仍可用，按需调用）
    systemPrompt: datedSystemPrompt('你是 mini-deepseek-harness 的教学助手，回答简洁；需要时可以用工具。'),
  })
  const loop = fiber.ctx['agent-loop']

  console.log(`===== 真 DeepSeek API 一轮（model: ${process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'}）=====`)
  console.log(`问：${ask}\n`)
  await loop.chat(ask)
  await session.flush()
  console.log(`${render(session.log)}\n`)
  console.log(`会话 id：${session.id}（JSONL：${resolve(dir, `${session.id}.jsonl`)}，resume 可续聊）`)
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
