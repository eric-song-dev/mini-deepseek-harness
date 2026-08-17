/** @mini-dsh/web-search —— web search 能力 seam + 双提供方 + web_search 工具（M10）。 */
export { WebError, createWebRuntime, webRuntime } from './web'
export type {
  WebRuntime,
  WebRuntimeConfig,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './web'
export { DEFAULT_FAKE_RESULT, FAKE_PROVIDER_ID, FakeWebSearchExhaustedError, createFakeWebSearch, fakeWebSearch } from './fake'
export type { FakeWebSearchConfig } from './fake'
export { WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_TIMEOUT_MS, WEB_SEARCH_TOOL_NAME, createWebSearchTool, webSearchTool } from './tool'
export type { WebSearchToolConfig } from './tool'
