# mini-deepseek-harness

一个精炼的 TypeScript agent harness：以 [CORDIS](https://www.npmjs.com/package/cordis) 插件内核为底座，
**一切皆为插件**；每次交互都是 append-only 会话事件，chat 只是日志的一个投影，Web 客户端优先。

> 上游参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（"Everything is a Plugin"）
>
> English version: [README.md](README.md)

## 特性

- **插件化架构**：`profile.yml` 列出插件行，经 cordis 组装成运行上下文；新增能力不改 agent loop
- **事件溯源会话**：append-only `SessionEvent` 日志是唯一真源，持久化 / resume / 崩溃恢复 / UI 全部由此投影
- **Trajectory 轨迹**：每一轮对话、工具调用、subagent 委派都可回放、可在 Web 端检视
- **LLM seam**：OpenAI 兼容 adapter（默认 DeepSeek；Ollama/vLLM 等端点通用），支持流式
- **工具与技能**：bash / 文件读·写·编辑工具；技能注册表 + filesystem 发现，兼容上游 `SKILL.md` frontmatter 契约
- **Subagent 与 workflow**：具名 spawn/fork 提供方 + 同线程脚本编排引擎，全部以可委派工具形式暴露
- **MCP 与 web search**：外部 MCP server（stdio）的工具注册进同一工具注册表；web search 能力 seam 内置 fake / DeepSeek 双提供方
- **Web 客户端优先**：HTTP/WebSocket RPC 桥，会话列表 / composer / 流式消息 / tool 卡片 / 轨迹面板

## 快速开始

要求：Node.js ≥ 22.19.0、pnpm 11。

```sh
pnpm install
pnpm test        # 全量测试（Vitest，node + jsdom 双 workspace）
pnpm typecheck   # 全量类型检查
```

Demo（除 `demo:real` 与浏览器 `demo:web` 外全部**零 API key**，由假 LLM 台词本驱动）：

```sh
pnpm demo:kernel packages/kernel/examples/hello-profile/profile.yml  # 启动一个 profile
pnpm demo:session   # 事件日志落盘 / resume / 崩溃恢复
pnpm demo:agent     # agent loop
pnpm demo:tools --clean      # 假 LLM 台词本驱动真工具（读→改→总结）
pnpm demo:trajectory --clean # 轨迹回放 + skill 自举两幕
pnpm demo:skills --clean     # 技能目录 + 按 description 路由 + 调用策略
pnpm demo:subagent --clean   # subagent 委派回收 + workflow 编排 + fatal/卸载
pnpm demo:mcp --clean        # 外部 MCP server 工具发现 + 真调用入轨迹 + 断开即撤销/重装
pnpm demo:websearch --clean  # web search 三层（seam + provider + 工具）+ 模型调用入轨迹 + 卸载/重装
pnpm demo:web:fake --clean   # 零 key Web 演示：假 LLM 台词本
pnpm demo:web --clean        # 浏览器对话用真模型（读 .env 的 key；系统提示自动注入当前时间）
pnpm demo:real --ask "用一句话介绍你自己"  # 真 API 冒烟（唯一需要 key 的命令，key 放 .env 或环境变量 DEEPSEEK_API_KEY）
```

## 包布局（monorepo）

| 包 | 一句话 |
|---|---|
| [`packages/kernel`](packages/kernel) | 启动器 + profile 加载（`profile.yml` → cordis ctx），唯一"启动"的地方 |
| [`packages/session`](packages/session) | 事件词汇 + append-only 日志 + SessionPersistence seam + JSONL 后端（日志是真源） |
| [`packages/test-support`](packages/test-support) | 测试公共语言：测试 ctx、测试服务注入、事件断言、假 LLM |
| [`packages/llm`](packages/llm) | LLM seam + OpenAI 兼容 adapter（默认 DeepSeek；Ollama/vLLM 通用；支持流式） |
| [`packages/agent`](packages/agent) | agent loop：全仓唯一的"拿输入→调模型→写输出"循环，每个动作都落会话日志 |
| [`packages/tools`](packages/tools) | Tools seam（注册表 + 执行管线 + approval hook 预留位）+ bash/文件读/写/编辑 |
| [`packages/web`](packages/web) | host：RpcBridge seam + HTTP/WS 桥 + SessionManager 门面 RPC |
| [`packages/client`](packages/client) | Client Slot seam + UI 插件：会话列表 / composer / 流式消息 / tool 卡片 / 轨迹面板 |
| [`packages/skill`](packages/skill) | Skills seam（注册表 + filesystem 发现）+ skill 工具（模型按需检索技能） |
| [`packages/subagent`](packages/subagent) | Subagents seam（具名 provider 注册表）+ spawn/fork 提供方 + 委派工具 |
| [`packages/workflow`](packages/workflow) | WorkflowEngine seam（同线程脚本编排）+ workflow 工具（模型写扇出脚本） |
| [`packages/mcp`](packages/mcp) | MCP 客户端桥（stdio）：外部 MCP server 的工具以 `mcp__<server>__<tool>` 注册进 Tools |
| [`packages/web-search`](packages/web-search) | web 能力 seam（provider 注册表 + 执行时选择）+ fake/deepseek 双提供方 + web_search 工具 |
| [`packages/bundle-web`](packages/bundle-web) | web profile 组合：client-shell + UI 插件排成浏览器应用 |
| [`apps/web`](apps/web) | Web 客户端壳（Vite entry，只注入 bundle-web，不是独立应用） |

## 文档

- 需求总纲（MVP / backlog / 里程碑 / seams）：[docs/requirements.md](docs/requirements.md)
- 里程碑详细 spec：[docs/milestones/](docs/milestones/README.md)（`M<n>.md`）
- 里程碑教程（随每个 M 同步产出的逐步构建指南）：[docs/tutorials/](docs/tutorials/README.md)
- 项目决策与进度记录：[.agents/notes/](.agents/notes/README.md)

## 状态

MVP（M0–M5）与 M6–M10 **全部完成**：

| 里程碑 | 交付 |
|---|---|
| M0 | 脚手架 + test-support + cordis 最小启动 |
| M1 | Session 事件词汇 + JSONL 持久化 + resume + 崩溃恢复 |
| M2 | LLM seam + 假 LLM + agent loop |
| M3 | Tools seam + bash/fs 工具 + 工具调用循环 |
| M4 | Web：RPC 桥 + 会话列表 + composer + 流式 + tool 卡片 |
| M5 | Trajectory 简化视图 + skills 子系统（含 skill 自举） |
| M6 | 自有 seam 注册全部可撤销：注册即 effect + HMR-safety 测试组 |
| M7 | 上游技能体系移植：SKILL.md frontmatter 契约 + fail-closed 校验 |
| M8 | subagents seam + spawn/fork 提供方 + WorkflowEngine 编排 + 委派/编排工具 |
| M9 | mcp-client 桥：stdio transport + 两阶段同步 + 断开即撤销 |
| M10 | web search 三层：能力 seam + 执行时选择 + fake/deepseek 双提供方 + web_search 工具 |

**Backlog**

- CLI 客户端
- 审批栈
- 工具并行调度
- Trajectory v2
- SQLite
- goal·plan·todo
- LSP
- compaction
- settings-i18n
- telemetry
- 动态插件热加载

- Backlog 详情：[`docs/requirements.md` §6](docs/requirements.md)

## 开发

- TDD 纪律：[`.agents/skills/tdd/SKILL.md`](.agents/skills/tdd/SKILL.md)；`pnpm test` 与 `pnpm typecheck` 是合入门槛。
- 决策与进度快照见 [`.agents/notes/README.md`](.agents/notes/README.md) 状态指针。
