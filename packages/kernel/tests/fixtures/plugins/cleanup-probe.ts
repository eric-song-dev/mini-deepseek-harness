import type { Context } from 'cordis'

// 记录本模块插件的 effect 清理是否被执行，供 loadProfile 失败路径的测试断言
// "失败时已装载的插件被 dispose（不泄漏 ctx）"。
let cleaned = false

export function resetCleanupProbe(): void {
  cleaned = false
}

export function wasCleaned(): boolean {
  return cleaned
}

export default function cleanupProbe(ctx: Context) {
  ctx.effect(() => () => {
    cleaned = true
  })
}
