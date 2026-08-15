import type { Context } from 'cordis'
import { clientShell, uiConversation, uiSessionList, uiTool } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * web profile 组合（M4）：把 client 侧插件按序叠加成浏览器可跑的应用。
 *
 * 与 host 侧的 profile 同构——"一切皆为插件"：apps/web 的 entry 壳只注入
 * 这一个插件（外加把窗口位置拼成桥地址），不包含任何业务逻辑。
 * 加面板（未来的 ui-trajectory 等）= 在列表里加一行，shell 与 entry 不改。
 */
export interface WebBundleConfig {
  /** 可注入的 client 连接（apps/web 用 wsClientBridge；测试用内存直连）。 */
  bridge: ClientBridge
}

export const webBundle = Object.assign(
  async function webBundle(ctx: Context, config: WebBundleConfig): Promise<void> {
    await ctx.plugin(clientShell, config)
    await ctx.plugin(uiSessionList)
    await ctx.plugin(uiConversation)
    await ctx.plugin(uiTool)
  },
  {},
)
