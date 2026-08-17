import { describe, expect, it } from 'vitest'
import { createWebRuntime } from '../src/index'
import type { WebSearchProvider } from '../src/index'

/**
 * 【M10 教程练习：写你自己的搜索提供方】（零 key）
 *
 * 写一个"笔记本"假提供方（id my-notebook），注册进 webRuntime，断言：
 *   1. 未配置 id 时恰好一个可用提供方被自动选中（我的提供方被调用）；
 *   2. 请求 maxResults: 3 时 seam 截断到 3 条 + truncated，答案保留；
 *   3. 红绿翻转（小白验收）：把 my-notebook 的 available() 方法删掉 →
 *      运行本测试看红（没有可用的搜索提供方）→ 改回来恢复绿。
 *
 * 运行：pnpm vitest run packages/web-search/tests/my-provider.test.ts
 * 教程：docs/tutorials/M10-web-search.md
 */

/** 我的"笔记本"搜索提供方：不联网，答案固定，返回 5 条来源。 */
const myNotebook: WebSearchProvider = {
  id: 'my-notebook',
  available: () => true,
  async search() {
    return {
      content: '我的笔记本搜索：全是本地笔记，不联网。',
      sources: [1, 2, 3, 4, 5].map((n) => ({ url: `https://note-${n}.example`, title: `笔记 ${n}` })),
      truncated: false,
    }
  },
}

describe('M10 教程练习：我的笔记本搜索提供方', () => {
  it('唯一可用提供方被自动选中', async () => {
    const web = createWebRuntime()
    web.registerSearchProvider(myNotebook)
    const result = await web.search({ query: 'cordis 是什么' })
    expect(result.content).toContain('不联网')
    expect(result.sources).toHaveLength(5)
    expect(result.truncated).toBe(false)
  })

  it('maxResults 在返回路径强制：截断 + truncated + 答案保留', async () => {
    const web = createWebRuntime()
    web.registerSearchProvider(myNotebook)
    const result = await web.search({ query: 'cordis 是什么', maxResults: 3 })
    expect(result.content).toContain('不联网')
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://note-1.example',
      'https://note-2.example',
      'https://note-3.example',
    ])
    expect(result.truncated).toBe(true)
  })
})
