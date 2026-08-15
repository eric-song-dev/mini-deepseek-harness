import type { Context } from 'cordis'
import { loadProfile } from './profile'

export interface RunningProfile {
  ctx: Context
  /** 发出 app/stop 并卸载全部插件。 */
  stop: () => Promise<void>
}

/** 装载 profile → 发出 app/ready → 返回运行句柄；stop() 收尾（app/stop + 卸载）。 */
export async function startProfile(profilePath: string): Promise<RunningProfile> {
  const { ctx } = await loadProfile(profilePath)
  ctx.emit('app/ready')
  return {
    ctx,
    stop: async () => {
      ctx.emit('app/stop')
      await ctx.fiber.dispose()
    },
  }
}
