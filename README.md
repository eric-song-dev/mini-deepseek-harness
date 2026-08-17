# mini-deepseek-harness

DeepSeek Harness 的教学迷你实现：**一切皆为插件**（CORDIS 内核），基础 chat + Trajectory 事件轨迹，Web 客户端优先。

> 上游参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 快速开始

```sh
pnpm install
pnpm test        # 全量测试（Vitest，node + jsdom 双 workspace）
pnpm typecheck   # 全量类型检查
pnpm demo:kernel packages/kernel/examples/hello-profile/profile.yml  # M0 demo：启动一个 profile
pnpm demo:session  # M1 demo：事件日志落盘 / resume / 崩溃恢复（零 API key）
pnpm demo:agent    # M2 demo：agent loop 三幕（零 API key）
pnpm demo:tools --clean  # M3 demo：假 LLM 台词本驱动真工具（读→改→总结，零 API key）
pnpm demo:trajectory --clean  # M5 demo：轨迹回放 + skill 自举两幕（零 API key）
pnpm demo:skills --clean      # M7 demo：技能目录 + 按 description 路由 + 调用策略（零 API key）
pnpm demo:subagent --clean  # M8 demo：subagent 委派回收 + workflow 编排 + fatal/卸载（零 API key）
pnpm demo:mcp --clean  # M9 demo：外部 MCP server 工具发现 + 真调用入轨迹 + 断开即撤销/重装（零 API key）
pnpm demo:websearch --clean  # M10 demo：web search 三层（seam+provider+工具）+ 模型调用入轨迹 + 卸载{error}/重装（零 API key）
pnpm demo:web --clean  # 浏览器对话用真模型（读 .env 的 key；系统提示自动注入当前时间）
pnpm demo:web:fake --clean  # 零 key Web 演示：假 LLM 台词本（第一轮 subagent 委派 + 第二轮外部 MCP 工具）
# 真 API 冒烟（唯一需要 key 的命令；key 放 .env 或环境变量 DEEPSEEK_API_KEY，其余全部零 key）：
pnpm demo:real --ask "用一句话介绍你自己"
```

## 包布局（monorepo）

| 包 | 一句话 |
|---|---|
| `packages/kernel` | 启动器 + profile 加载（`profile.yml` → cordis ctx），唯一"启动"的地方 |
| `packages/session` | 事件词汇 + append-only 日志 + SessionPersistence seam + JSONL 后端（日志是真源） |
| `packages/test-support` | 测试公共语言：测试 ctx、测试服务注入、事件断言、假 LLM |
| `packages/llm` | LLM seam + OpenAI 兼容 adapter（默认 DeepSeek；Ollama/vLLM 通用；M4 起流式） |
| `packages/agent` | agent loop：全仓唯一的"拿输入→调模型→写输出"循环（M3 起工具调用，M4 起流式） |
| `packages/tools` | Tools seam（注册表 + 执行管线 + approval hook 预留位）+ bash/文件读/写/编辑 |
| `packages/web` | host：RpcBridge seam + HTTP/WS 桥 + SessionManager 门面 RPC（静态文件 + 实时事件） |
| `packages/client` | Client Slot seam + UI 插件：会话列表 / composer / 流式消息 / tool 卡片 / 轨迹面板（M5） |
| `packages/skill` | Skills seam（注册表 + filesystem 发现）+ skill 工具（模型按需检索技能，M5；M7 起 SKILL.md frontmatter 契约 + 7 个技能） |
| `packages/subagent` | Subagents seam（具名 provider 注册表）+ spawn/fork 提供方 + subagent 委派工具（M8） |
| `packages/workflow` | WorkflowEngine seam（同线程脚本编排）+ workflow 工具（模型写扇出脚本，M8） |
| `packages/mcp` | MCP 客户端桥（stdio）：外部 MCP server 的工具以 mcp__<server>__<tool> 注册进 Tools（M9） |
| `packages/web-search` | web 能力 seam（ctx.web 提供方注册表 + 执行时选择）+ fake/deepseek 双提供方 + web_search 工具（M10） |
| `packages/bundle-web` | web profile 组合：client-shell + UI 插件排成浏览器应用 |
| `apps/web` | Web 客户端壳（Vite entry，只注入 bundle-web，不是独立应用） |

## 文档

- 需求总纲（MVP / backlog / 里程碑 / seams / 教程交付要求）：[docs/requirements.md](docs/requirements.md)
- 里程碑详细 spec：`docs/milestones/M<n>.md`
- 里程碑教程（面向 AI 编程小白，随每个 M 同步产出）：[docs/tutorials/](docs/tutorials/README.md)
- 项目决策与进度记录（跨 session durable memory）：[.agents/notes/](.agents/notes/)

## 开发纪律

- TDD：`.agents/skills/tdd/SKILL.md`（从本项目目录启动的 DSH session 自动发现）
- 当前进度：见 `.agents/notes/README.md` 的状态指针

## 状态

MVP（M0–M5）与 M6–M10 **全部完成**：M0（脚手架 + test-support + cordis 最小启动）、
M1（Session 事件词汇 + JSONL 持久化 + resume + 崩溃恢复）、M2（LLM seam + 假 LLM +
agent loop）、M3（Tools seam + bash/fs 工具 + 工具调用循环）、M4（Web：RPC 桥 + 会话
列表 + composer + 流式 + tool 卡片）、M5（Trajectory 简化视图 + skills 子系统，含
skill 自举）、M6（自有 seam 注册全部可撤销：注册即 effect + HMR-safety 测试组）、M7
（上游技能体系移植：SKILL.md frontmatter 契约 + fail-closed 校验 + 六个技能移植）、
M8（subagents seam + spawn/fork 提供方 + WorkflowEngine 脚本编排 + 委派/编排工具，
loop 零专属改动）、M9（mcp-client 桥：stdio transport + 两阶段同步 + 断开即撤销，
外部 MCP server 工具注册进 Tools）、M10（web search 三层：ctx.web 能力 seam + 执行时
选择六支 + fake/deepseek 双提供方 + web_search 工具稳定注册，第一个外部 HTTP 工具，
`demo:websearch` 三幕零 key 验收，`demo:web:fake` 第三轮为浏览器可见的 web_search 场景）。
下一工作单元 = backlog #1 **CLI 客户端**（interactive TUI + headless 双模式）；其余
backlog（审批栈 / Trajectory v2 / SQLite / goal·plan·todo / LSP / compaction /
settings-i18n / telemetry / 动态插件热加载 / 压轴教程）见 `docs/requirements.md` §6
与 notes 状态指针。
