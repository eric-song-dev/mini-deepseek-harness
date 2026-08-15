import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { ClientRoot, clientShell } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * M4 教程练习（步骤 3）：给你的页面加一个 Slot 注册的小 UI 插件。
 *
 * 玩法（红绿翻转）：
 * 1. 先跑 `pnpm vitest run packages/client/tests/my-first-slot.test.tsx` —— 绿。
 * 2. 把 myExtraPlugin 里注册的 slot 名从 'my-panel' 改成 'hello-panel' —— 红
 *    （断言找的是 [data-slot="my-panel"]，改名后这个 slot 名下没有面板）。
 * 3. 改回来 —— 绿。
 *
 * 要点：客户端也是插件系统——注册一个 slot = 页面上多一个面板，
 * shell（ClientRoot）与 entry 一行没改。
 */

/** 你的第一个 UI 面板：一个极简 React 组件。 */
function MyExtraPanel() {
  return <div className="my-extra">我的第一个 Slot 面板</div>
}

/** 你的第一个 ui 插件：把面板注册进 slot-registry（inject 声明依赖）。 */
const myExtraPlugin = Object.assign(
  function myExtraPlugin(ctx: Context): void {
    ctx['slot-registry'].register('my-panel', MyExtraPanel)
  },
  { inject: ['slot-registry'] },
)

describe('M4 练习：Slot 注册的小 UI 插件', () => {
  it('新插件注册的面板出现在 extras 区，shell 与 entry 无需改动', async () => {
    const bridge: ClientBridge = {
      request: async () => undefined as never,
      onEvent: () => () => {},
      close: () => {},
    }
    const ctx = new Context()
    await ctx.plugin(clientShell, { bridge })
    await ctx.plugin(myExtraPlugin)

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ClientRoot ctx={ctx} />)
      })
      expect(
        document.querySelector('.dsh-extras [data-slot="my-panel"] .my-extra')?.textContent,
      ).toBe('我的第一个 Slot 面板')
    } finally {
      await act(async () => root?.unmount())
      container.remove()
      await ctx.fiber.dispose()
    }
  })
})
