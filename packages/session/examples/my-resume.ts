/**
 * M1 教程练习脚本：resume 一个断尾会话，观察自动补写的 turn/end（reason: crash）。
 * 用法：pnpm tsx packages/session/examples/my-resume.ts [目录] <会话id>
 *   <会话id> 由 my-crash.ts 打印出来。
 */
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'

const dir = resolve(process.argv[2] ?? '.mini-dsh/sessions')
const id = process.argv[3]
if (!id) {
  console.error('用法：pnpm tsx packages/session/examples/my-resume.ts [目录] <会话id>')
  process.exit(1)
}

function render(events: readonly SessionEvent[]): string {
  return events
    .map((e) => `  #${String(e.seq).padStart(2)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload ?? '')}`)
    .join('\n')
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const manager = ctx.get('session-manager')!

  const session = await manager.resume(id)
  console.log(`resume 后的完整日志：\n${render(session.log)}`)
  console.log('\n注意最后一条：turn/end 的 reason 是 crash —— 崩溃恢复补写的（幂等：再 resume 也不会补第二条）。')
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
