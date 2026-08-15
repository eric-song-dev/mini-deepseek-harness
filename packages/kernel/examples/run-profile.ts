// M0 演示启动器：装载一个 profile 并保持运行，Ctrl+C 优雅停止。
// 用法: pnpm demo:kernel <profile.yml>
import { format } from 'node:util'
import { startProfile } from '@mini-dsh/kernel'

const profilePath = process.argv[2]
if (!profilePath) {
  console.error('用法: pnpm demo:kernel <profile.yml>')
  process.exit(2)
}

const running = await startProfile(profilePath, {
  // 裸 cordis 的 logger 没有控制台输出；这里挂一个最简 console exporter
  //（上游用 logger-console 插件做这件事，M0 先用三行内联版）。
  setup: (ctx) => {
    ctx.logger.exporter({
      export: (message) => {
        console.log(`[${message.type}] ${format(...message.args)}`)
      },
    })
  },
})
running.ctx.logger.info('profile 已启动: %s（Ctrl+C 停止）', profilePath)

process.on('SIGINT', () => {
  void running.stop().finally(() => process.exit(0))
})

// 保持进程存活：信号监听不会让 Node 驻留，空循环时 tsx 也会强制退出，
// 一个超长 interval 是最稳的 keep-alive（真正终止靠上面的 SIGINT handler）。
setInterval(() => {}, 2 ** 30)
