# 上游参考指引（deepseek-ai/deepseek-harness）

"参照 deepseek-ai/deepseek-harness" 的具体执行协议。**按下面的优先级查阅，不要凭印象写、不要全量读仓库。**

> **M7 起（2026-08-16 增补）**：每个 M 开工时，先读本文件"## M7–M11 上游源码索引"里该 M 的**文档与代码**，把 seam 契约与裁剪结论记入 `.agents/notes/proposed/`，再定稿 `docs/milestones/M<n>.md` 的 spec。每个 M 的 spec 文件自带一份同源索引（定稿时以 spec 为准）。

## 查阅优先级

| 优先级 | 来源 | 何时用 |
|---|---|---|
| 1 | 本地克隆的上游源码（建议一次克隆到**本项目仓库外**）：`git clone --depth 1 git@github.com:deepseek-ai/deepseek-harness.git ../deepseek-harness-upstream` | 实现某 seam 前读原版对应 README（离线、可 grep） 我已安装好，不必安装 |
| 2 | 本地已安装的 `@deepseek-ai/dsh`（**真实运行中的 harness**）：`/Users/ericsong/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh/`，含 `bin.js`、`lib/`、`config/agent-presets/{code,cordis,minimal,standard}/`（preset 的 `agent.cordis.yml` + `preset.yml` 是组合的最佳实例） | 看 CLI 行为、看真实 profile 组合长什么样 |
| 3 | GitHub 在线（默认分支 `master`）：列目录 `curl -sL https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/<path>`；读文件 `curl -sL https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/<path>` | 本地克隆不可用时按需 fetch 单文件 |
| 4 | DeepWiki（`https://deepwiki.com/deepseek-ai/deepseek-harness`）+ web_search | 概念性问题、找不到文件时兜底 |

## 关键路径索引（按需读，一次只读一个文件）

- 总体架构：`docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/glossary.zh.md`
- 核心 loop（全仓唯一具体循环逻辑）：`packages/core/agent-loop/README.md`、`packages/core/agent/README.md`
- Session/轨迹：`packages/core/session/README.md`、`docs/subsystems/session.zh.md`、`docs/subsystems/persistence.zh.md`、`packages/session/session-persistence-jsonl/README.md`
- 工具：`docs/subsystems/tools.zh.md`、`docs/tool-execution-pipeline.zh.md`
- LLM：`packages/llm/`、`docs/subsystems/llm-streaming.zh.md`
- Skills：`docs/subsystems/skills.zh.md`、`packages/skill/README.md`（M7 移植见下方专门索引）
- Web：`docs/subsystems/web-server.zh.md`、`packages/web/`、`packages/client/README.md`、`packages/client/web/`
- Trajectory 视图：`packages/client/ui-trajectory/README.zh.md`
- 组合（bundle/profile）：`packages/bundle/{base,web-app}/`、`config/agent-presets/*/agent.cordis.yml`（本地安装）
- CLI 客户端：`apps/cli/`（backlog 时再读）

## M7–M11 上游源码索引（每 M 一份，开工前按序读）

> 统一顺序：子系统文档 → 包 README(.zh) → 核心 src → 边界/反例文件。一次只读一个文件。

### M7 · 原版技能体系（skills）

- 总纲与格式：`docs/subsystems/skills.zh.md`；`packages/skill/skill-filesystem/README.zh.md`（**SKILL.md 格式规范：frontmatter 字段、布尔语义、fail-closed**）
- 发现实现：`packages/skill/skill-filesystem/src/index.ts`（`discoverRoot` / `parseSkillFile` / `parseFrontmatter` / `parseInvocationPolicy` / `frontmatterBoolean` / `rejectLegacyInvocationKey` / `isPotentialSkillPath`）
- 注册表与工具：`packages/skill/skill/README.zh.md` + `src/index.ts`（`SkillRegistry` / `renderSkillContent` / `skills/change` 事件）；`packages/skill/tool-skill/README.zh.md` + `src/index.ts`（目录 digest、`<available_skills>` 模板、用户显式注入）
- 技能正文（移植候选，逐字读）：`.agents/skills/{dsh-code-review,dsh-prose-standard,dsh-trim-cot-leakage,dsh-pre-push-checks,dsh-doc-standards,dsh-archive-agent-notes}/SKILL.md`
- 格式/反例参考：`.agents/skills/{dsh-translate-docs,dsh-doc-site-sync,dsh-merging-stacked-prs,record-browser-gif}/SKILL.md`、`apps/cli/config/agent-presets/cordis/skills/*/SKILL.md`
- UI 形态（一两句）：`packages/client/ui-skill/README.zh.md`
- 关键事实：`.claude/skills -> ../.agents/skills` 是**符号链接**（Claude Code 兼容别名），发现只扫 `.agents/skills` 一个物理根

### M8 · subagent / workflow

- 总纲：`docs/subsystems/subagent.zh.md`、`docs/subsystems/workflow.zh.md`
- subagent 核心：`packages/subagent/subagent/src/{index,types}.ts`（`SubagentRuntime` 服务 + `subagent/*` 事件 + StartRequest/Result/Run/Provider 词汇）
- 三种驱动：`packages/subagent/subagent-spawn-in-process/`、`subagent-fork-in-process/`、`subagent-in-process-driver/`（各 README.zh.md + src；driver 的 `startInProcessRun` 五步最贴近 mini 路径）
- 工具：`packages/subagent/tool-subagent/README.zh.md` + src（前台收集/生命周期）
- workflow：`packages/workflow/workflow/src/{index,types,runtime-types}.ts`（`WorkflowEngine` + `WorkflowError` + `workflow/*` 事件）；`packages/workflow/tool-workflow/README.zh.md` + `src/types.ts`（`tool-workflow/*` 事件与不变量）
- 隔离模型（**只读理解，mini 不照搬**）：`packages/workflow/workflow-worker-thread/README.zh.md`
- 可继续后台子 agent（M8 砍，不读）：`packages/subagent/subagent/src/{continuation,descriptor}.ts`

### M9 · MCP

- 无独立子系统文档，总览在包内：`packages/mcp/README.zh.md`、`packages/mcp/mcp-client/README.zh.md`
- 设计决策核心：`.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.zh.md`（MCP 只是"工具生产者"、两阶段同步、`mcp__<server>__<raw>` 命名）
- 实现：`packages/mcp/mcp-client/src/{index,connection,tools,transport}.ts`
- 接入点：`packages/core/tools/src/index.ts`（MCP 工具以原始 `ToolDefinition` 注册进 `ctx.tools` 的 ToolRuntime，之后自动流入现有执行管线）
- 自动重连（**只读理解，mini 不照搬**）：`.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.zh.md`

### M11 · web search（`ctx.web` 能力 seam）

- 总纲：`docs/subsystems/web.zh.md`（三层拆分、选择语义、WebError 码表、seam 契约）
- Service Definition：`packages/web/web/README.zh.md`（服务 API 表、选择表、词汇）
- 消费方：`packages/web/tool-web/README.zh.md` + `src/search.ts`（`web_search` 工具：稳定注册、结果格式、提示词段、配置表）
- 真提供方：`packages/web/web-search-deepseek/README.zh.md` + `src/{index,provider,types}.ts`（Anthropic 兼容端点、native web_search 工具、块解析映射、严格模式）
- 工具编写约定：`docs/cookbook/adding-a-tool.zh.md`（execute 约定；mini 的 M3 已实现大部分）
- 模型可见 schema：`docs/tool-catalog.zh.md` 的 `web_search` 段
- 提供方对比（一眼即可）：`packages/web/web-search-perplexity/README.zh.md`、`web-search-exa/README.zh.md`

### M10 · plan / todo（goal 不做）

- 总纲：`docs/subsystems/plan.zh.md`
- plan-mode：`packages/plan/plan-mode/README.zh.md` + `src/{index,types}.ts`（`PlanModeController`：get/set、pre-step pending 机制、`plan:policy` section、`exit_plan_mode`、`/plan`）
- todo：`packages/todo/tool-todo/README.zh.md` + `src/index.ts`（`todo_write` 整表替换、校验、渲染）
- 数据模型：`packages/core/session/src/types.ts`（`TodoItem`、`todo/write` 事件）
- 事件/工具目录：`docs/persistence-catalog.md`（`plan/mode`、`todo/write`）、`docs/tool-catalog.md`（`exit_plan_mode`、`todo_write`）
- Web（一两句）：`packages/client/ui-plan/README.zh.md`
- 边界（一眼即可）：`docs/subsystems/goal.zh.md` 前 80 行——goal 是独立域、不依赖 plan/todo，mini 不做 goal 不断链

## 使用纪律

1. **照搬概念，不照搬代码**：原版规模远大于 mini，直接抄会失控；先读原版 README 的"Service / 配置 / 已知限制"章节，提取 seam 契约与命名，再在 mini 里写自己的实现。
2. **一次只读一个文件**，读完立刻记录关键契约到本 M 的 notes；不要抓取整个仓库。
3. 本地安装的 launcher 与上游源码可能版本不同步，冲突时以 ../deepseek-harness-upstream 为准（注意记录差异到 notes）。
4. **M7–M11 开工协议**：定稿 spec 前**必须**按本文件对应索引读完上游文档与代码（顺序：子系统文档 → 包 README → 核心 src → 边界/反例），把"照搬哪些概念、砍掉哪些复杂度、mini seam 怎么挂接"记入 `.agents/notes/proposed/`；不读上游凭印象写 spec 视为违规（用户明确要求）。
