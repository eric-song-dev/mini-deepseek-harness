import type { Context } from 'cordis'

// 记录本模块收到的 app 生命周期事件与 effect 清理，供 startProfile 的测试断言顺序。
const seen: string[] = []

export function lifecycleEvents(): string[] {
  return seen
}

export default function lifecyclePlugin(ctx: Context) {
  ctx.on('app/ready', () => {
    seen.push('ready')
  })
  ctx.on('app/stop', () => {
    seen.push('stop')
  })
  ctx.effect(() => () => {
    seen.push('cleaned')
  })
}
