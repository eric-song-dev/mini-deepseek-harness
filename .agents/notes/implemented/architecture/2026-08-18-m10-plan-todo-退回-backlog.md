# M10 原排期（plan/todo）退回 backlog；web search 重编号为 M10

- **日期**：2026-08-18
- **状态**：`implemented`（重编号已生效，web search 作为 M10 已完成；plan/todo 保留在
  requirements §6 backlog（2026-08-18 插入"工具并行调度"后现列第 6 项））

## 背景

M9 收尾后，`docs/milestones/M10.md`（plan / todo draft 概览）质量不达标，用户拍板：
不继续定稿，直接退回 backlog。原 M11（web search）顺位前移，重编号为 M10。

## 决策

1. **plan / todo 取消排期**：`docs/milestones/M10.md` 删除；goal / plan / todo 合并回
   backlog（requirements §6 第 5 项："goal / plan / todo（原版任务系统，完整三件套）"）。
   上游调研不丢失：plan/todo 的上游事实摘要保留在
   `2026-08-16-m7-m10-排期.md` 的"上游调研摘要"节；原 M10.md 全文在 git 历史可查。
2. **web search 重编号 M11 → M10**：`docs/milestones/M11.md` 改名为 `M10.md`（内容随改）；
   教程 slug `M11-web-search` → `M10-web-search`；requirements / upstream.md /
   milestones README / 根 README / 两篇教程的编号引用同步改。spec 仍是 draft，
   开工协议不变（先读 upstream.md 的 M10 索引再定稿）。
3. 下一个工作单元 = **M10（web search）**。

## 影响

- `docs/requirements.md` v0.7：头部状态、§6 排期表与 backlog 第 5 项、§9 里程碑表与
  教程表。
- `docs/milestones/`：`M10.md`（web search，draft）；README 范围行。
- `docs/references/upstream.md`：删除 plan/todo 索引节，web search 节改 M10，
  "M7–M11" → "M7–M10"。
- `docs/tutorials/M9-mcp.md`、`M8-subagent-workflow.md`：删 plan/todo 展望、改编号。
- 根 `README.md` 排期段、`.agents/notes/README.md` 状态指针。

## 遗留问题 / 下一步

- 下个 session：做 **M10（web search）**——先按 `docs/references/upstream.md` 的 M10
  索引读上游（web 子系统 / `ctx.web` / tool-web / deepseek 提供方），定稿
  `docs/milestones/M10.md`（置 proposed），再 TDD。
- plan / todo 若将来重新排期：上游调研见本 note 背景所述两处来源，按 M7–M10 开工
  协议重新做上游必读 + spec。
