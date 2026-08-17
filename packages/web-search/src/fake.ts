import type { Context } from 'cordis'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from './web'

/**
 * fakeWebSearch：台词本假提供方（M10，mini 专属——上游没有假提供方）。
 *
 * 教学用途：零 API key 也能把"模型 → web_search 工具 → ctx.web seam → 提供方"
 * 全链路跑起来并回放。它也是"provider 是普通对象"的最简示范——注册进 seam 的
 * 不是工具、不是插件，而是一个 {id, available, search} 能力实现。
 * 台词本按序消费、耗尽抛错：与 fakellm 同款纪律，防止演示/测试在"静默空转"
 * 下通过。
 */

/** 提供方 id（seam 注册表键）。 */
export const FAKE_PROVIDER_ID = 'fake'

/** 台词本耗尽（防止演示/测试静默空转）。 */
export class FakeWebSearchExhaustedError extends Error {
  constructor(callIndex: number) {
    super(`假搜索提供方的预设结果已用尽（第 ${callIndex} 次搜索）`)
    this.name = 'FakeWebSearchExhaustedError'
  }
}

/** 无台词本时的内置固定结果（demo 默认用）。 */
export const DEFAULT_FAKE_RESULT: WebSearchResult = {
  content: '这是一条假搜索结果（fakeWebSearch 的内置台词）：它不联网，只用来演示 web_search 全链路。',
  sources: [
    {
      url: 'https://koishi.chat/guide/plugin/context.html',
      title: 'Koishi 插件上下文',
      snippet: 'CORDIS 是 Koishi 的插件内核：服务、事件、组合。',
    },
    {
      url: 'https://martinfowler.com/eaaDev/EventSourcing.html',
      title: 'Event Sourcing（Martin Fowler）',
      snippet: 'Event sourcing persists the state as a sequence of events.',
    },
  ],
  truncated: false,
}

/** fakeWebSearch 插件配置。 */
export interface FakeWebSearchConfig {
  /** 预设结果序列（按搜索调用顺序弹出）；缺省用内置固定结果。 */
  results?: readonly WebSearchResult[]
}

/** 造一个台词本假提供方。 */
export function createFakeWebSearch(results?: readonly WebSearchResult[]): WebSearchProvider {
  let calls = 0
  return {
    id: FAKE_PROVIDER_ID,
    available: () => true,
    async search(_request: WebSearchRequest): Promise<WebSearchResult> {
      calls++
      const result = results?.[calls - 1] ?? (results === undefined ? DEFAULT_FAKE_RESULT : undefined)
      if (result === undefined) throw new FakeWebSearchExhaustedError(calls)
      return result
    },
  }
}

/**
 * 插件：把假提供方注册进 ctx.web（inject: ['web']）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销。
 */
export const fakeWebSearch = Object.assign(
  function fakeWebSearch(ctx: Context, config: FakeWebSearchConfig = {}): void {
    const off = ctx.web.registerSearchProvider(createFakeWebSearch(config.results))
    ctx.effect(() => () => off())
  },
  { inject: ['web'] },
)
