import type { Context } from 'cordis'

export interface GreetConfig {
  message?: string
}

export default function greetPlugin(ctx: Context, config: GreetConfig = {}) {
  ctx.provide('deep-greeting', config.message ?? 'hello')
}
