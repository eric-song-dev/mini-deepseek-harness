# 项目 notes（决策与进度记录）

这是本项目跨 session 的 durable memory。每个新 session 开始时**先读这里**再动手。

## 目录约定

| 目录 | 用途 |
|---|---|
| `proposed/` | 待实施/进行中的设计决策、方案、进度快照 |
| `implemented/` | 已完成落地的决策记录（按主题归档，如 `architecture/`） |
| `rejected/` | 被否决的方案及否决理由（防止未来重复讨论） |
| `archived/` | 已过时的历史记录 |

## 记录格式

文件名：`YYYY-MM-DD-<kebab-case主题>.md`

每个记录包含：
- **状态**：`proposed` / `implemented` / `rejected`
- **背景**：为什么有这个决策
- **决策**：决定了什么（引用 `docs/requirements.md` 或相关文档）
- **影响**：对哪些包/seam 有影响
- **遗留问题**（可选）：未决事项与下一步

## 跨 session 工作流

1. 新 session 开始：读本文件（状态指针）→ 读 `docs/requirements.md`（总纲）→ 读当前 M 的 spec（`docs/milestones/M<n>.md`）→ 读 `proposed/` 里未完成的事项。
2. 若当前 M 的 spec 缺失或不够具体：**先定稿/细化 spec 并记入 notes，再开始编码**。
3. 工作期间：会话内长任务用 goal 工具跟踪；决策产生时立即写 note。
4. session 结束前：把当前状态（哪个测试在红、下一个行为、里程碑进度）写入 `proposed/` 最新进度快照，供下个 session resume。
5. 决策落地后：从 `proposed/` 移到 `implemented/`（按主题归档）。

## 当前状态指针

- **M0–M10 全部完成** —— 下一个工作单元 = **backlog #1：CLI 客户端**
  （interactive TUI + headless 双模式，用户明确指定）。开工方式同里程碑：先在
  `docs/milestones/` 建 spec（现无 CLI spec 文件，需从零定稿任务拆解/TDD 顺序/验收/
  教程主题——CLI 是 backlog 项，无上游必读索引要求，可参考上游 `apps/cli/` 按需调研），
  再 TDD。其余 backlog（审批栈 / 工具并行调度（上游调研已写入 §6 第 3 项）/
  Trajectory v2 / SQLite / goal·plan·todo / LSP / compaction / settings-i18n /
  telemetry / 动态插件热加载（前置已备）/ 压轴教程）见 `docs/requirements.md` §6。
- 排期决策（M7–M10 已全部执行完毕，归档）：`implemented/architecture/2026-08-16-m7-m10-排期.md`、
  `implemented/architecture/2026-08-18-m10-plan-todo-退回-backlog.md`
- 最近进度快照：`proposed/2026-08-16-mini-deepseek-harness-v0.1.md`（含 M10 完成快照）
- M0 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m0-技术决策.md`
- M1 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m1-session-日志决策.md`
- M2 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m2-llm-与-loop-决策.md`
- M3 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m3-tools-决策.md`
- M4 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m4-web-决策.md`
- M5 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m5-轨迹-与-skills-决策.md`
- M6 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m6-注册可逆-决策.md`
- M7 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m7-技能移植-决策.md`
  （上游调研：`implemented/architecture/2026-08-16-m7-上游调研.md`）
- M8 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m8-子代理-与-workflow-决策.md`
  （上游调研：`implemented/architecture/2026-08-16-m8-上游调研.md`）
- M9 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m9-mcp-决策.md`
  （上游调研：`implemented/architecture/2026-08-16-m9-上游调研.md`）
- M10 技术决策（已落地归档）：`implemented/architecture/2026-08-18-m10-web-search-决策.md`
  （上游调研：`implemented/architecture/2026-08-18-m10-web-search-上游调研.md`）
- 总纲：`docs/requirements.md`（v0.8：MVP + M6–M10 全部完成；下一工作单元 = backlog #1 CLI）
- 新 session 启动 prompt：`docs/session-prompts/template.md`（固定模板，不要改动）
