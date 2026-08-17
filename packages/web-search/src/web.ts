import 'cordis'
import type { Context } from 'cordis'
import type { Unregister } from '@mini-dsh/tools'

/**
 * web 能力 seam（M10，上游 ctx.web 的 mini 版，只做 search）。
 *
 * 教学要点（上游 docs/subsystems/web.zh.md 的三层拆分第一层——Service Definition）：
 * - 一个 seam 上可以有多个提供方（provider 插件组），提供方注册的是**能力**
 *   （WebSearchProvider）而非工具；面向模型的名称/schema/结果格式归消费方
 *   （webSearchTool）唯一所有；
 * - **选择在执行时解析，绝不依赖注册/配置/HMR 顺序**：配置 id 命中 / 唯一可用
 *   自动选择 / 多可用歧义报错 / 无可用报错，六支全做；
 * - `available()` 是廉价本地检查（凭据/配置），禁止网络调用——它只是选择输入，
 *   不是健康检查；
 * - seam 在返回路径强制执行 `maxResults`：提供方超量返回 → 截断 `sources[]` +
 *   `truncated`。
 */

/** 一条可引用的来源：url 必填，其余可缺（不强迫提供方编造）。 */
export interface WebSearchSource {
  url: string
  title?: string
  snippet?: string
  /** 提供方给的发布时间/页面年龄串（ISO-8601 或提供方自有格式）。 */
  publishedAt?: string
}

/** 一次搜索请求：模型只给 query；maxResults 是消费方（部署）上限，由 seam 强制。 */
export interface WebSearchRequest {
  query: string
  maxResults?: number
}

/** 归一化搜索结果：可选答案 + 来源列表 + 截断标记。 */
export interface WebSearchResult {
  /** 可选提供方生成的答案/摘要（fake 提供方有；deepseek 提供方省略）。 */
  content?: string
  sources: WebSearchSource[]
  /** seam 为满足 maxResults 截掉了来源（或提供方如实报告截断）。 */
  truncated: boolean
}

/** 一个搜索后端：注册进 WebRuntime，由 seam 在执行时选中。 */
export interface WebSearchProvider {
  /** 注册表键（如 'fake'、'deepseek-official'）。 */
  id: string
  /** 廉价本地检查（凭据是否存在、配置是否可解析）；禁止发起网络调用。 */
  available(): boolean
  /** 执行一次搜索；返回归一化结果（超量来源由 seam 截断）。 */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** WebRuntime 插件配置（profile.yml 插件行 options）。 */
export interface WebRuntimeConfig {
  /** 显式提供方 id；缺省时按"唯一可用自动选择"规则解析。 */
  searchProvider?: string
}

/** 抽象服务（ctx.web）：提供方注册表 + 执行时选择 + maxResults 强制。 */
export interface WebRuntime {
  /**
   * 注册搜索提供方；重 id 抛 WebError WEB_DUPLICATE_PROVIDER。
   * 返回幂等撤销函数（M6 注册可逆），注册方插件经 ctx.effect 挂接。
   */
  registerSearchProvider(provider: WebSearchProvider): Unregister
  /** 解析提供方并运行一次搜索；能力无法运行时抛 WebError。 */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** Web 能力错误：结构化 code（open string），消费方按 code 路由。 */
export class WebError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/** 默认 WebRuntime 实现：内存注册表 + 执行时选择 + 返回路径截断。 */
export function createWebRuntime(config: WebRuntimeConfig = {}): WebRuntime {
  const providers = new Map<string, WebSearchProvider>()

  const registerSearchProvider: WebRuntime['registerSearchProvider'] = (provider) => {
    if (providers.has(provider.id)) {
      throw new WebError(`搜索提供方 id 重复：${provider.id}`, 'WEB_DUPLICATE_PROVIDER')
    }
    providers.set(provider.id, provider)
    let active = true
    return () => {
      // 幂等：只撤销"我注册的那一个"——若已被同名重注册，不误删新提供方（tools 注册表同款）
      if (active && providers.get(provider.id) === provider) providers.delete(provider.id)
      active = false
    }
  }

  const search: WebRuntime['search'] = async (request, signal) => {
    const provider = select(providers, config.searchProvider)
    const result = await provider.search(request, signal)
    const max = request.maxResults
    if (max !== undefined && result.sources.length > max) {
      return { ...result, sources: result.sources.slice(0, max), truncated: true }
    }
    return result
  }

  return { registerSearchProvider, search }
}

/** 执行时选择（六支，绝不依赖注册顺序）。 */
function select(providers: Map<string, WebSearchProvider>, configuredId: string | undefined): WebSearchProvider {
  if (configuredId !== undefined && configuredId !== '') {
    const target = providers.get(configuredId)
    if (!target) {
      throw new WebError(`配置的搜索提供方未注册：${configuredId}`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!target.available()) {
      throw new WebError(`配置的搜索提供方不可用：${configuredId}`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return target
  }
  const usable = [...providers.values()].filter((provider) => provider.available())
  if (usable.length === 1) return usable[0]!
  if (usable.length === 0) {
    throw new WebError('没有可用的搜索提供方', 'WEB_PROVIDER_UNAVAILABLE')
  }
  throw new WebError(
    `多个搜索提供方可用但未配置 id（候选：${usable.map((provider) => provider.id).join(', ')}）`,
    'WEB_PROVIDER_AMBIGUOUS',
  )
}

/** webRuntime 插件：把默认实现注册成 `web` 服务（换注册表 = 换提供服务的插件）。 */
export function webRuntime(ctx: Context, config: WebRuntimeConfig = {}): void {
  ctx.provide('web', createWebRuntime(config))
}

// 服务类型增强：插件可经 ctx.web 取到 seam（tools 同款模式）。
declare module 'cordis' {
  interface Context {
    web: WebRuntime
  }
}
