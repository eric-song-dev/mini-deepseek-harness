import type { Context } from 'cordis'
import type { Tool } from '@mini-dsh/tools'
import { WebError } from './web'
import type { WebRuntime, WebSearchResult } from './web'

/**
 * webSearchTool 消费方（M10，上游 tool-web 的 mini 版，只做 search）。
 *
 * 面向模型的一切的唯一归属方：工具名、description、参数 schema、结果数量上限、
 * 超时预算。**绝不 import 具体提供方、绝不调用 available()、绝不枚举提供方**——
 * 唯一执行路径是 `ctx.web.search()`，提供方选择完全留在 seam 内（上游同款纪律）。
 *
 * 稳定注册（上游 tool-web 的核心语义）：注册跟随产品启用状态而非后端可用性——
 * provider 缺失/错误配置/暂不可用，`web_search` 仍注册；执行时的结构化 WebError
 * 被转成模型可读的 `{ error }` 结果（mini"输出是内容、异常是结果"纪律，skill 工具
 * 同款），而不是把整轮炸掉。要彻底移除工具，卸载本插件即可。
 *
 * mini 裁剪：上游的 output.render 层不存在——工具返回**结构化归一化结果**
 * （{content?, sources, truncated}），轨迹面板直接展示 result JSON；cite 指引
 * （上游系统提示词段）并进 description（mini 无 system-prompt seam）。
 * `maxResults` 与超时都是部署设置，不是模型参数。
 */

/** 工具名（模型可见）。 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/** 默认来源数量上限（上游 WEB_SEARCH_MAX_RESULTS 同值）。 */
export const WEB_SEARCH_MAX_RESULTS = 8

/** 默认超时预算（上游 searchTimeoutMs 同值，ms）。 */
export const WEB_SEARCH_TIMEOUT_MS = 30000

/** webSearchTool 插件配置（profile.yml 插件行 options）。 */
export interface WebSearchToolConfig {
  /** 一次搜索返回的来源数量上限；seam 在返回路径强制。 */
  searchMaxResults?: number
  /** 协作式超时预算（ms）：到期中止本次搜索（提供方尊重 signal 时生效）。 */
  searchTimeoutMs?: number
}

/** 造一个 web_search 工具（execute 闭包持有注入的 web seam 与部署配置）。 */
export function createWebSearchTool(web: WebRuntime, config: WebSearchToolConfig = {}): Tool {
  const maxResults = config.searchMaxResults ?? WEB_SEARCH_MAX_RESULTS
  const timeoutMs = config.searchTimeoutMs ?? WEB_SEARCH_TIMEOUT_MS
  return {
    declaration: {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        'Search the web for current information. Returns an optional summary answer and a list of source URLs. '
        + 'Use the returned source snippets when available, and cite the relevant URLs as markdown links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
    async execute(input) {
      const query = input.query
      if (typeof query !== 'string' || query.trim().length === 0) {
        return { error: 'query must be a non-empty string' }
      }
      // 协作式超时：mini 没有上游的 timeout-policy 包装层，工具自建 signal
      // （seam 的 signal 参数原样透传给提供方；提供方尊重 signal 时生效）。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`web_search 超时（${timeoutMs}ms）`)), timeoutMs)
      try {
        const result: WebSearchResult = await web.search({ query, maxResults }, controller.signal)
        return result
      } catch (error) {
        if (error instanceof WebError) return { error: error.message }
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * 插件：把 web_search 工具注册进 tools seam（inject ['tools','web']）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销。
 */
export const webSearchTool = Object.assign(
  function webSearchTool(ctx: Context, config: WebSearchToolConfig = {}): void {
    const off = ctx.tools.register(createWebSearchTool(ctx.web, config))
    ctx.effect(() => () => off())
  },
  { inject: ['tools', 'web'] },
)
