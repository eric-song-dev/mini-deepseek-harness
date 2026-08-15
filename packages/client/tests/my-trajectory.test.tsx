import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Context } from 'cordis'
import { projectTurns } from '@mini-dsh/session'
import type { SessionEvent } from '@mini-dsh/session'
import { ClientRoot, clientShell, useSlotStore } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * M5 教程练习（步骤 3）：给轨迹面板改一个 slot 玩法——注册自己的"迷你轨迹"面板。
 *
 * 玩法（红绿翻转）：
 * 1. 跑 `pnpm vitest run --project dom packages/client/tests/my-trajectory.test.tsx` —— 绿。
 * 2. 把 myMiniTrace 里注册的 slot 名从 'my-mini-trace' 改成 'trace-v2' —— 红
 *    （断言找的是 [data-slot="my-mini-trace"]，改名后这个 slot 名下没有面板）。
 * 3. 改回来 —— 绿。
 *
 * 要点：轨迹面板本身只是一个注册进 slot `trajectory` 的组件；任何 slot 面板
 * 都消费同一份 store.events，可以用 projectTurns 做出自己的投影视图——
 * shell（ClientRoot）与 entry 一行没改。
 */

/** 你的迷你轨迹面板：只显示第一轮的耗时（projectTurns 的另一个消费者）。 */
function MyMiniTrace() {
  const store = useSlotStore()
  const turns = projectTurns(store.events)
  const first = turns[0]
  return (
    <div className="my-mini-trace">
      {first ? `第一轮「${first.userText ?? '—'}」耗时 ${first.durationMs}ms` : '还没有轮次'}
    </div>
  )
}

/** 你的 ui 插件：把面板注册进 slot-registry。 */
const myMiniTrace = Object.assign(
  function myMiniTrace(ctx: Context): void {
    ctx['slot-registry'].register('my-mini-trace', MyMiniTrace)
  },
  { inject: ['slot-registry'] },
)

describe('M5 练习：轨迹面板的 slot 玩法', () => {
  it('自己的投影面板进 extras 区，显示第一轮耗时', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 0, payload: { id: 's1', title: '', createdAt: 0 } },
      { seq: 2, type: 'turn/start', ts: 10, payload: undefined },
      { seq: 3, type: 'user', ts: 11, payload: { content: '你好' } },
      { seq: 4, type: 'assistant', ts: 13, payload: { content: '你好呀' } },
      { seq: 5, type: 'turn/end', ts: 14, payload: { reason: 'done' } },
    ]
    const bridge: ClientBridge = {
      request: async <T,>(method: string): Promise<T> => {
        if (method === 'session.resume') return { meta: events[0]!.payload, events } as T
        throw new Error(`练习桥不处理 ${method}`)
      },
      onEvent: () => () => {},
      close: () => {},
    }
    const ctx = new Context()
    await ctx.plugin(clientShell, { bridge })
    await ctx.plugin(myMiniTrace)

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ClientRoot ctx={ctx} />)
      })
      await act(async () => {
        await ctx.get('client-session-store')!.open('s1')
      })
      expect(
        document.querySelector('.dsh-extras [data-slot="my-mini-trace"] .my-mini-trace')?.textContent,
      ).toContain('第一轮「你好」耗时 4ms')
    } finally {
      await act(async () => root?.unmount())
      container.remove()
      await ctx.fiber.dispose()
    }
  })
})
