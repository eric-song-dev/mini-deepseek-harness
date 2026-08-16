/**
 * Slot seam（M4）：client 侧的 UI 注册点——"一切皆为插件"在 UI 层的延续。
 *
 * 教学要点：注册表本身**不依赖任何 UI 框架**。值是不透明句柄：
 * 当前的渲染实现是 React（组件经薄封装注册，shell 认组件类型），
 * 未来换框架只换 shell 的装配与渲染，注册表与 ui 插件契约不变。
 */

/** 已知的装配位（shell 按这些名字布局；未来 ui-* 插件可扩展新名字）。 */
export type SlotName = 'session-list' | 'conversation' | 'tool' | (string & {})

/** 撤销函数：调用后撤销本次注册；幂等（重复调用无害）。 */
export type Unregister = () => void

/** Slot 注册表：插件注册 UI 句柄，client-shell 按 slot 装配成页面。 */
export interface SlotRegistry {
  /**
   * 注册一个 slot 的 UI 句柄；同名重复注册抛错。
   * 返回幂等撤销函数（M6 注册可逆）：撤销后 get 空、slots 不含该名，
   * 同名可重注册。注册方插件用 `ctx.effect(() => () => off())` 挂接，
   * 卸载即撤销——上游 "registrations are effects"。
   */
  register(slot: string, entry: unknown): Unregister
  /** 取回某 slot 的注册值；未注册返回空数组。 */
  get(slot: string): readonly unknown[]
  /** 全部已注册的 slot 名（装配顺序按注册顺序）。 */
  slots(): readonly string[]
}

export function createSlotRegistry(): SlotRegistry {
  const entries = new Map<string, unknown>()
  return {
    register(slot, entry) {
      if (entries.has(slot)) throw new Error(`slot 已注册：${slot}（一个 slot 只允许一个注册者）`)
      entries.set(slot, entry)
      let active = true
      return () => {
        // 幂等：只撤销"我注册的那一个"——若已被同名重注册，不误删新句柄
        if (active && entries.get(slot) === entry) entries.delete(slot)
        active = false
      }
    },
    get(slot) {
      const entry = entries.get(slot)
      return entry === undefined ? [] : [entry]
    },
    slots() {
      return [...entries.keys()]
    },
  }
}
