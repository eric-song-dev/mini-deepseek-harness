import type { Context } from 'cordis'

declare function helloPlugin(ctx: Context, config?: { message?: string }): void

export default helloPlugin
