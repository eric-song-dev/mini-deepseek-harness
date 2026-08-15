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

- 里程碑：**M2（待开始）** —— 详细 spec：`docs/milestones/M2.md`（已定稿，状态 proposed）
- 最近进度快照：`proposed/2026-08-16-mini-deepseek-harness-v0.1.md`
- M0 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m0-技术决策.md`
- M1 技术决策（已落地归档）：`implemented/architecture/2026-08-16-m1-session-日志决策.md`
- 总纲：`docs/requirements.md`（v0.1，需求已定稿）
- 新 session 启动 prompt：`docs/session-prompts/template.md`（固定模板，不要改动）
