/**
 * M1 教程练习脚本：写一半就"崩溃"（SIGKILL 自杀），制造一个断尾日志。
 * 用法：pnpm tsx packages/session/examples/my-crash.ts [目录]
 *   默认目录 ./.mini-dsh/sessions；跑完把打印出来的会话 id 交给 my-resume.ts。
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'

const dir = resolve(process.argv[2] ?? '.mini-dsh/sessions')

async function main(): Promise<void> {
  await mkdir(dir, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const manager = ctx.get('session-manager')!

  const session = await manager.create({ title: '练习：写到一半的会话' })
  session.ctx.emit('turn/start')
  session.ctx.emit('user', { content: '这句说完，进程就被杀了……' })
  await session.flush() // 确保已写进文件

  console.log(`会话 id：${session.id}`)
  console.log(`日志文件：${resolve(dir, `${session.id}.jsonl`)}`)
  console.log('进程即将被 SIGKILL 杀死（来不及 emit turn/end）……')
  process.kill(process.pid, 'SIGKILL')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
