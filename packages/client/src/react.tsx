import type { Context } from 'cordis'
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ComponentType, ReactElement } from 'react'
import type { ClientSessionStore } from './store'

/**
 * React 绑定（M4）：slot 注册表的"第一个渲染实现"。
 *
 * 注册表本身不依赖 React（值是不透明句柄），这里约定"句柄是 React 组件"，
 * ClientRoot 按 slot 名装配成单页。未来换框架 = 换这个装配层。
 * 渲染发生在 cordis 插件作用域之外，所以这里用 ctx.get 取服务（不靠 inject）。
 */

/** slot 组件的上下文：直接携带 store（组件只认 store，不认 cordis）。 */
export const SlotContext = createContext<ClientSessionStore | null>(null)

/** slot 组件内部取 store 的钩子（useSyncExternalStore：store 变更即重渲染）。 */
export function useSlotStore(): ClientSessionStore {
  const store = useContext(SlotContext)
  if (!store) throw new Error('SlotContext 缺失：slot 组件必须在 ClientRoot 内渲染')
  useSyncExternalStore(store.subscribe, () => store.version)
  return store
}

/**
 * 单页装配：三个已知 slot 区域（会话列表 / 对话 / 工具）。
 * 未注册的 slot 区域留空——加一个 ui-* 插件就是加一个面板，shell 不改。
 */
export function ClientRoot(props: { ctx: Context }): ReactElement {
  const registry = props.ctx.get('slot-registry')
  const store = props.ctx.get('client-session-store')
  if (!registry || !store) throw new Error('ClientRoot 需要 clientShell 已装载（slot-registry + client-session-store）')
  const renderSlot = (slot: string) => {
    const [entry] = registry.get(slot)
    if (!entry) return null
    const Component = entry as ComponentType
    return <Component />
  }
  return (
    <SlotContext.Provider value={store}>
      <div className="dsh-shell">
        <aside className="dsh-area dsh-area-list">{renderSlot('session-list')}</aside>
        <main className="dsh-area dsh-area-chat">{renderSlot('conversation')}</main>
        <aside className="dsh-area dsh-area-tools">{renderSlot('tool')}</aside>
      </div>
    </SlotContext.Provider>
  )
}
