/**
 * M1 演示：事件日志的真源 —— 落盘、重开（resume）、崩溃恢复。
 * 零 API key：不接任何 LLM，事件全部手工 emit，展示"日志先于 loop"的架构。
 *
 * 用法：pnpm demo:session [--dir <目录>] [--clean]
 *   --dir <目录>  会话文件目录（默认 ./.mini-dsh/sessions）
 *   --clean       先清空目录再演示（方便反复跑）
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : resolve('.mini-dsh', 'sessions')

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

/** 启动一套最小 runtime：JSONL 后端 + SessionManager（模拟一次"进程启动"）。 */
async function boot(): Promise<{ ctx: Context, manager: SessionManager }> {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  return { ctx, manager: ctx.get('session-manager')! }
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  // ---- 第一段：正常会话（emit 一轮 → 落盘）----
  let { ctx, manager } = await boot()
  const s1 = await manager.create({ title: '正常会话' })
  s1.ctx.emit('turn/start')
  s1.ctx.emit('user', { content: '你好' })
  s1.ctx.emit('assistant', { content: '你好呀！' })
  s1.ctx.emit('turn/end', { reason: 'done' })
  await s1.flush()
  console.log(`[会话 ${s1.id}] 已落盘：\n${render(s1.log)}\n`)

  // ---- 第二段：模拟崩溃（turn/start 之后"进程被杀"，没有 turn/end）----
  const s2 = await manager.create({ title: '崩溃会话' })
  s2.ctx.emit('turn/start')
  s2.ctx.emit('user', { content: '说到一半……' })
  await s2.flush()
  console.log(`[会话 ${s2.id}] 模拟崩溃：turn/start 后进程退出，日志断尾，没有 turn/end\n`)
  await ctx.fiber.dispose() // 整个"进程"退出（正常路径里此刻不会执行任何收尾）

  // ---- 第三段：重启（新 ctx + 新 manager = 新进程），resume ----
  ;({ ctx, manager } = await boot())
  console.log('===== 重启后 resume（正常会话）=====')
  console.log(`${render((await manager.resume(s1.id)).log)}\n`)

  console.log('===== 重启后 resume（崩溃会话 → 自动补 turn/end）=====')
  const r2 = await manager.resume(s2.id)
  console.log(`${render(r2.log)}\n`)

  console.log(`会话目录：${dir}`)
  console.log(`会话列表：${(await manager.list()).map((m) => `${m.id} 「${m.title}」`).join('、')}`)
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
