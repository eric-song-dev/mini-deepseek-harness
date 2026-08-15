# mini-deepseek-harness 需求文档

> 版本：v0.1 · 2026-08-16 · 状态：需求已讨论定稿，待进入 M0 编码
> 上游参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（"Everything is a Plugin"，113k+ stars）

## 1. 项目定位

一个**教学用途**的 DeepSeek Harness 迷你实现。学生通过它学习：

- CORDIS 插件内核（依赖注入、服务/事件、组合）
- "一切皆为插件"的 agent harness 架构
- 事件溯源：append-only 会话日志 + 投影（Trajectory）
- 一个可运行的 LLM agent 系统（chat + 工具调用 + Web 客户端）
- 随里程碑同步产出的**入门教程**（面向 AI 编程小白，见 §5.1）

## 2. 硬约束（不可妥协）

1. **保留 CORDIS 内核**：使用官方 `cordis` npm 包，不手写内核；本项目只实现插件层与组合层。
2. **一切皆为插件**：agent = 一个 profile 组合（插件行按序叠加），任何功能都是插件。
3. **Session 事件日志是真源**：所有对话与工具活动都是 append-only `SessionEvent`，内存与持久化、UI 均从此投影。
4. **Trajectory 是灵魂**：日志（真源）→ 投影 → 视图三件套缺一不可；chat 只是产生日志的来源之一。
5. **可扩展性优先于功能完整**：每个能力 = 抽象服务 seam + 至少一个实现；未来原版功能以插件形式加入，不改 agent loop。

## 3. 客户端范围

| 客户端 | 优先级 | 说明 |
|---|---|---|
| Web | **P0（本版）** | 会话列表/新建/resume、composer、流式消息、tool 卡片、Trajectory 视图 |
| CLI | Backlog | interactive TUI + headless 双模式 |

## 4. 技术选型（已锁定）

| 项 | 决定 |
|---|---|
| 语言/工程 | TypeScript + pnpm monorepo（业界标准，教学价值最高） |
| 内核 | 官方 `cordis` 包 |
| 前端 | React + Vite，仅做客户端壳与视图插件 |
| 服务端 | Node.js HTTP + WebSocket（host↔client RPC 桥） |
| LLM | 单一 OpenAI 兼容 adapter（默认对接 DeepSeek API；Ollama/vLLM 等端点同样可用），seam 预留多 provider |
| 持久化 | JSONL 后端（SessionPersistence seam 可换） |
| 测试 | Vitest + 假 LLM + 事件断言；TDD 纪律见 `.agents/skills/tdd/` |
| 工具集（MVP） | bash、文件读/写/编辑；无审批栈（直接执行，但工具执行管线预留 approval hook） |

## 5. MVP 范围（P0，共 10 项）

按依赖顺序：

| # | 需求 | 说明 |
|---|---|---|
| 1 | 内核与组合 | `profile.yml` 列出插件行、`bin` 启动器、patch 叠加的最小形态 |
| 2 | Session 事件词汇 | `turn/start`、`turn/end`、`user`、`assistant`、`tool` 等；append-only |
| 3 | 持久化 + resume | JSONL 后端；会话可重开继续（跨 session 工作流的地基） |
| 4 | LLM seam | 抽象 `LLM` 服务 + OpenAI 兼容 adapter + 流式输出 |
| 5 | Agent loop | 单轮 chat + 工具调用循环；**每个动作落日志** |
| 6 | 最小工具集 | bash + 文件读/写/编辑（没有工具记录 Trajectory 就只剩聊天） |
| 7 | Web 基础 UI | 会话列表/新建/resume、composer、流式消息、tool 卡片 |
| 8 | Trajectory 简化视图 | 按轮分组事件表 + 点选检查器（token/耗时/输入输出）；虚拟滚动与时间线概览放 v2 |
| 9 | Skills 子系统 | 注册表 + filesystem 发现 + `skill` 工具（mini 版自举跑 TDD skill） |
| 10 | test-support | 测试脚手架：创建 ctx、假 LLM、事件断言 |

## 5.1 教程交付（每个里程碑同步，P0）

**每完成一个里程碑 M，同步写出该 M 的教程**（与代码同节奏交付，不许攒到最后补）。

- **读者画像**：AI 编程小白 —— 第一次接触 agent、插件架构、事件溯源的学生。默认读者只会基础 TypeScript，其余概念一律从零解释。
- **每篇教程必讲**：
  1. **动机**：这个 M 解决什么问题、为什么排在这个顺序（依赖关系与前一个 M 的关系）这个 M 在整个系统里处于什么位置？；
  2. **design** 这个 M 做了什么，design，以及必要时画出图（用 plantUML 的格式，比如 class diagram, sequence diagram, flowchart）
  3. **新概念**：本 M 出现的每个新概念，首次出现必须解释（如：什么是 seam、什么是 append-only 日志、什么是投影、什么是 RPC 桥）；
  4. **tradeoff**：关键取舍与理由（如：为什么日志是真源而不是"数据库行 + UI 状态"、为什么 MVP 不做审批栈、为什么 JSONL 而非 SQLite、为什么 loop 是唯一具体逻辑）；
  5. **动手练习**：一个可跟做的最小实验（如"给你的 profile 加一个打印事件的插件"），练习驱动代码可直接运行。
- **形式**：Markdown，放 `docs/tutorials/M<n>-<slug>.md`，中文，配目录索引 `docs/tutorials/README.md`。
- **验收（小白验收）**：零 API key 也能跟做 —— 练习全部由假 LLM / 测试脚手架驱动；教程中的命令与代码块可复制即跑。
- **性质**：教程是文档，不适用 TDD 红绿循环，但必须与里程碑验收一起完成。

## 6. Backlog（按优先级）

1. **CLI 客户端**（用户明确指定）：interactive TUI + headless 双模式
2. 审批/权限栈（bash approval；MVP 已留 hook）
3. Trajectory v2：虚拟滚动 + 时间线概览（贴近原版 [ui-trajectory](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/README.zh.md)）
4. SQLite 持久化后端（演示 seam 换后端）
5. subagent / workflow（多智能体编排）
6. MCP、LSP
7. goal / plan / todo（原版任务系统）
8. compaction（上下文压缩）
9. settings UI / 主题 token / i18n
10. telemetry、session 搜索查询
11. 动态插件热加载（Web 里 define/run cordis 插件，原版亮点，放最后）
12. **压轴教程**："给 mini 版写你的第一个插件" 综合实战篇 —— 每里程碑的入门教程属 P0 同步交付（§5.1），此项是收官的独立成章练习

## 7. 包布局

```
apps/web/                  # Web 客户端壳（Vite entry，只注入，不是独立应用）
packages/kernel/           # 启动器 + profile 加载（依赖官方 cordis）
packages/session/          # SessionEvent 词汇 + Session + SessionPersistence seam + JSONL 后端
packages/llm/              # LLM seam + OpenAI 兼容 adapter
packages/tools/            # 工具注册表 + 执行管线 + bash/fs 工具
packages/agent/            # system-prompt 组合 + agent-loop（全仓唯一具体循环逻辑）
packages/skill/            # skills 注册表 + filesystem 发现 + skill 工具
packages/web/              # HTTP 服务 + RPC/WS 桥
packages/client/           # ui-conversation / ui-trajectory / ui-tool / client-shell（Slot 注册）
packages/bundle-web/       # web profile 组合（把上述插件排成 bundle）
packages/test-support/     # 测试脚手架
docs/                      # 需求、架构文档、tutorials/ 里程碑教程
.agents/                   # TDD skill 与 notes（本项目的开发纪律）
```

包 scope：`@mini-dsh/*`。

## 8. Seams（扩展点清单）

未来原版功能都从这些 seam 挂进来，不改 loop：

| Seam | 形态 | 未来接入 |
|---|---|---|
| `LLM` | 抽象服务 | 多 provider registry、本地模型 |
| `SessionPersistence` | 抽象服务 | SQLite 后端、远端存储 |
| `Tools` | 注册表 + 执行管线 | approval 栈、MCP 工具 |
| `Skills` | provider 注册表 | 远程 skill 市场、bundled skill |
| Client `Slot` | UI 注册点 | 原版任意 ui-* 插件 |
| 事件 | `session/*`、`agent/*` | telemetry、compaction、subagent |

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0** | 仓库脚手架 + test-support + cordis 最小启动（profile.yml → ctx 组装）+ TDD skill/notes 落地 | 空 profile 能启动、ctx 能注入测试服务 |
| **M1** | Session 事件词汇 + JSONL 持久化 + resume | 事件断言测试通过；崩溃恢复补 `turn/end` |
| **M2** | LLM seam + 假 LLM + agent loop | 假 LLM 跑通单轮 chat，全量落日志 |
| **M3** | tools（bash/fs）+ 工具调用循环 | 工具事件入日志，循环多步正确 |
| **M4** | Web：RPC 桥 + 会话列表 + composer + 流式 + tool 卡片 | 浏览器里完成一次真实对话 |
| **M5** | Trajectory 简化视图 + skills 子系统 | 轨迹可回放 M4 的对话；`skill` 工具能加载 TDD skill |

每个里程碑：**有测试 + 可 demo + 有文档 + 有教程**（教程要求见 §5.1，随 M 同步交付）。

教程落点（每 M 一篇，索引进 `docs/tutorials/README.md`）：

| 里程碑 | 教程主题（slug 建议） |
|---|---|
| M0 | `M0-kernel-and-plugins` — 什么是 CORDIS：服务、事件、组合、profile |
| M1 | `M1-event-log` — 事件日志与真源：为什么 append-only、崩溃恢复 |
| M2 | `M2-llm-and-loop` — seam 与假 LLM：agent loop 怎么驱动会话 |
| M3 | `M3-tools` — 工具注册与执行：工具事件如何进轨迹 |
| M4 | `M4-web` — host↔client 桥：流式消息怎么到浏览器 |
| M5 | `M5-trajectory-and-skills` — 投影视图与 skills：灵魂的最后一环 |

每个 M 的**详细执行 spec** 放 `docs/milestones/M<n>.md`（任务拆解、TDD 顺序、验收、教程要求、收尾动作），§9 只保留概览；进入某 M 时先定稿它的 spec 再编码。新 session 的启动 prompt 用固定模板：`docs/session-prompts/template.md`。

## 10. Definition of Done

- 每个包有 README（教学导向，解释"为什么是这个 seam"）
- seam 契约有测试覆盖
- 端到端：一条 chat 全流程可被 Trajectory 完整回放
- 决策变更记录在 `.agents/notes/`
- 本 M 教程已同步完成并通过"小白验收"（§5.1）

## 11. 开发纪律（跨 session 工作流）

- **TDD**：red → green → refactor，详见 `.agents/skills/tdd/SKILL.md`（从本项目目录新开的 session 自动发现）。
- **决策记录**：`.agents/notes/{proposed,implemented,rejected}/`，会话内用 goal 工具管长任务。
- **会话连续性**：每个 session 的 trajectory 持久化在 `$DSH_HOME/sessions`，可 resume 继续。

## 12. 上游参考指引

"参照 deepseek-ai/deepseek-harness" 的执行协议（查阅优先级、关键路径索引、使用纪律）见 `docs/references/upstream.md`。规则：**照搬概念不照搬代码，一次只读一个文件**。
