import type { Context } from 'cordis'

// 最简插件：监听 app 生命周期事件并打印。
// 这是"一切皆为插件"的第一个可运行例子（M0 教程的动手练习起点）。
export default function helloPlugin(ctx: Context) {
  ctx.on('app/ready', () => {
    ctx.logger.info('hello, mini-deepseek-harness!')
  })
  ctx.on('app/stop', () => {
    ctx.logger.info('bye')
  })
}
