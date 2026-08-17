# @mini-dsh/web-search

web search 能力的三层拆分（上游 `ctx.web` 架构的 mini 版，只做 search）：

1. **能力 seam**（`src/web.ts`，服务键 `ctx.web`）：`WebSearchProvider` 注册表 +
   执行时选择（六支）+ 返回路径强制 `maxResults`；
2. **提供方插件**（`src/fake.ts` / `src/deepseek.ts`）：注册**能力**而非工具；
3. **消费方**（`src/tool.ts`）：`web_search` 工具——面向模型的名字/schema/结果格式
   唯一归属方，**稳定注册**。

**换提供方 = profile 里换一行插件；模型侧（web_search 工具）与 agent loop 一行不改。**
这是 mini 的第一个外部 HTTP 工具，也是第一个多 provider 注册表 seam（LLM seam 是单 adapter）。

## 为什么是这个 seam

M3 的工具执行代码长在工具里（bash/文件）；M9 的 MCP 把工具注册桥接进来。这个包回答的是
另一个问题：**能力从哪来？** 答案是"多个可替换的后端 + 运行时选一个"。把"搜索"做成能力
seam，而不是写死一个工具，是为了让"换搜索后端"不动模型侧——提供方注册的是能力
（`{id, available, search}`），面向模型的一切集中在唯一的消费方。

## 用法

```yaml
# profile.yml：加插件行即获 web_search 能力（fake 提供方零 key 可跑）
plugins:
  - name: '@mini-dsh/web-search'        # 三行插件：seam + 提供方 + 工具
  - name: './plugins/fake.ts'           # 换提供方 = 换这一行（deepseek.ts 读 DEEPSEEK_API_KEY）
```

```ts
// 插件行（见 examples/plugins/ 的 default 导出 shim）：
await ctx.plugin(webRuntime)             // ctx.web（可配 { searchProvider: 'deepseek-official' }）
await ctx.plugin(fakeWebSearch)          // 或 deepseekWebSearch
await ctx.plugin(webSearchTool)          // 注册 web_search 工具（{ searchMaxResults, searchTimeoutMs }）
```

模型会看到 `web_search(query)` 工具；执行走 `ctx.web.search()`，提供方选择完全留在 seam 内。

## 关键语义

| 事项 | 契约 |
|---|---|
| 选择（执行时解析） | 配置 id 命中/未注册（`CONFIGURED_MISSING`）/不可用（`CONFIGURED_UNAVAILABLE`）/唯一自动/歧义（`AMBIGUOUS`，消息含候选 id）/无可用（`UNAVAILABLE`）。绝不依赖注册顺序 |
| `available()` | 廉价本地检查（凭据/配置），禁止网络调用 |
| maxResults | 消费方配置（默认 8），seam 返回路径强制：超量 → 截断 `sources[]` + `truncated: true` |
| 稳定注册 | provider 缺失/不可用时工具仍在；执行返回模型可读 `{ error }` 结果（不炸轮）；意外错误照旧上抛（crash 路径） |
| deepseek 提供方 | Anthropic 兼容 Messages API（`POST {baseURL}/messages`，默认 `https://api.deepseek.com/anthropic/v1`，**不复用** `$DEEPSEEK_BASE_URL`）；原生 `web_search_20250305` 服务器工具；只解析结构化 `web_search_tool_result` 块（无块 → 严格模式抛 `WEB_PROVIDER_ERROR`，绝不从模型文本抓 URL）；按 URL 去重；snippet 来自 text 块 `citations[]`；`content` 省略（提供方答案不受信任） |
| 错误 | `WebError { code }`（open code string）：`WEB_PROVIDER_UNAVAILABLE` / `CONFIGURED_MISSING` / `CONFIGURED_UNAVAILABLE` / `AMBIGUOUS` / `DUPLICATE_PROVIDER` / `ABORTED` / `PROVIDER_ERROR` / `CREDENTIAL_MISSING` |
| 注册可逆 | `registerSearchProvider` 返回幂等撤销函数；provider/工具插件均经 `ctx.effect` 挂接（M6 纪律，HMR-safety 测试守护） |

## 裁剪（相对上游 dsh-web + tool-web + web-search-deepseek）

`web_fetch` / turndown / fetch 安全策略、credentials seam、settings 层叠加、`$DSH_WEB_SEARCH_PROVIDER`
env 层、`web/deepseek-search-llm-request` 请求日志事件、output.render 层与 `card: 'web'` UI 卡片
（工具返回结构化结果，轨迹面板直接展示 result JSON）、perplexity / exa 提供方、Web 配置 UI。
取舍理由见 [M10 教程](../../docs/tutorials/M10-web-search.md) §4 与
[上游调研 note](../../.agents/notes/implemented/architecture/2026-08-18-m10-web-search-上游调研.md)。

## 教学入口

- 零 key 演示：`pnpm demo:websearch --clean`（三幕：四行插件即获能力 → 模型调用入轨迹 →
  卸载 provider 得 `{error}` + 重装恢复）；`pnpm demo:kernel
  packages/web-search/examples/websearch.profile.yml` 看 profile 形态
- 教程 + 练习：`docs/tutorials/M10-web-search.md`（练习：写你自己的搜索提供方，零 key）
- 测试分层：`tests/web-contract.test.ts`（seam 契约：六支选择/截断/可逆）→
  `tests/fake.test.ts`（台词本提供方）→ `tests/tool.test.ts`（消费方稳定注册）→
  `tests/deepseek.test.ts`（真提供方经假 HTTP 端点）→ `tests/e2e.test.ts`（零 key 全链路）
  → `tests/my-provider.test.ts`（教程练习）
