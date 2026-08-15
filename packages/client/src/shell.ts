import 'cordis'
import type { Context } from 'cordis'
import type { ClientBridge } from './connection'
import { createClientSessionStore } from './store'
import type { ClientSessionStore } from './store'
import { createSlotRegistry } from './slots'
import type { SlotRegistry } from './slots'

/**
 * client-shell 插件（M4）：client 侧的组合层——提供桥、session store、slot 注册表。
 *
 * ui 插件（ui-session-list / ui-conversation / ui-tool）注入这些服务，
 * 各自把 UI 组件注册进 slot；React 只是"第一个渲染实现"，读注册表装配页面。
 * 换框架（比如未来想接别的渲染器）只换装配层，ui 插件与服务不动。
 */
export interface ClientShellConfig {
  /** 可注入的 client 连接（apps/web 用 wsClientBridge，测试用内存直连）。 */
  bridge: ClientBridge
}

export const clientShell = Object.assign(
  function clientShell(ctx: Context, config: ClientShellConfig): void {
    ctx.provide('client-bridge', config.bridge)
    ctx.provide('slot-registry', createSlotRegistry())
    ctx.provide('client-session-store', createClientSessionStore(config.bridge))
  },
  {},
)

// 服务类型增强：ui 插件可通过 ctx['client-session-store'] 等取到。
declare module 'cordis' {
  interface Context {
    'client-bridge': ClientBridge
    'slot-registry': SlotRegistry
    'client-session-store': ClientSessionStore
  }
}
