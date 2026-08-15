import type { Context } from 'cordis'

export interface GreetConfig {
  message?: string
}

// 测试夹具插件：把 options.message 作为 'greeting' 服务注入。
export default function greetPlugin(ctx: Context, config: GreetConfig = {}) {
  ctx.provide('greeting', config.message ?? 'hello')
}
