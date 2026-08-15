import type { Context } from 'cordis'
import { loadProfile } from './profile'

export interface RunningProfile {
  ctx: Context
  /** 发出 app/stop 并卸载全部插件。 */
  stop: () => Promise<void>
}

export interface StartProfileOptions {
  /** 插件装载后、发出 app/ready 之前对 ctx 执行（例如挂载 logger 输出）。 */
  setup?: (ctx: Context) => void
}

/** 装载 profile → setup(ctx) → 发出 app/ready → 返回运行句柄；stop() 收尾（app/stop + 卸载）。 */
export async function startProfile(
  profilePath: string,
  options: StartProfileOptions = {},
): Promise<RunningProfile> {
  const { ctx } = await loadProfile(profilePath)
  options.setup?.(ctx)
  ctx.emit('app/ready')
  return {
    ctx,
    stop: async () => {
      ctx.emit('app/stop')
      await ctx.fiber.dispose()
    },
  }
}
