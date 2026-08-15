# 需求定稿：mini-deepseek-harness v0.1

- **日期**：2026-08-16
- **状态**：`proposed`（需求定稿；M0、M1 已完成，当前里程碑 M2 待开始）

## 背景

用户（eric-song-dev）要在本仓库实现一个教学用途的 DeepSeek Harness 迷你版：保留 CORDIS 内核与"一切皆为插件"哲学，实现基础 chat、保留 Trajectory（灵魂），Web 客户端优先、CLI 放 backlog，且要为原版全部功能预留扩展接口。

## 决策（本 session 讨论 + 用户拍板）

1. **内核**：TypeScript + pnpm monorepo，使用官方 `cordis` 包（不手写内核）。
2. **LLM**：单一 DeepSeek API 兼容 adapter（即 OpenAI 兼容协议；Ollama/vLLM 等端点通用），seam 预留多 provider。
3. **Trajectory MVP**：简化版 —— 按轮分组事件表 + 点选检查器（token/耗时/输入输出）；虚拟滚动与时间线概览放 v2。
4. **MVP 工具**：bash + 文件读/写/编辑；无审批栈（执行管线预留 approval hook）。
5. **TDD skill**：项目内 `.agents/skills/tdd/SKILL.md`（已创建，本 session 技能目录已热更新生效）。
6. **客户端**：Web 为 P0；CLI（interactive TUI + headless）在 backlog 首位。

## 影响

- 总纲：`docs/requirements.md`（v0.1）——MVP 10 项、backlog 12 项、seams 清单、M0–M5 里程碑。
- 包布局：`@mini-dsh/*`，布局见总纲 §7。
- 开发纪律：TDD（见 skill）+ notes 工作流（本目录）。

## 增补（2026-08-16，用户确认）

7. **教程同步交付**：每完成一个里程碑 M，同步写出该 M 的入门教程（面向 AI 编程小白：动机、新概念解释、tradeoff、可跟做练习；零 API key 可跑），放 `docs/tutorials/M<n>-<slug>.md`。总纲新增 §5.1，DoD 与 TDD skill 检查清单同步更新。原 backlog 第 12 项改为"压轴教程：写你的第一个插件"综合实战篇。

8. **文档单一真源，prompt 固定化**：每个 M 的详细执行 spec 归入 `docs/milestones/M<n>.md`（M0 已定稿），requirements §9 只留概览；新 session 启动 prompt 用固定模板 `docs/session-prompts/template.md`，不再把 M 的细节写进 prompt。

## 下一步（下个 session 起）

- 启动方式：复制 `docs/session-prompts/template.md` 全文作为新 session 的第一条消息。
- 执行依据：`docs/milestones/M2.md`（**已定稿**，状态 proposed，M1 收尾时撰写：LLM seam +
  假 LLM + agent loop，任务拆解/TDD 顺序/验收/教程要求齐备）。

## M1 完成快照（2026-08-16 增补）

- **状态**：M1 已实现并通过验收（58 测试全绿、typecheck 绿、demo 三幕零 key 可跑、教程三个
  练习实测通过——含 SIGKILL 真崩溃 + resume 自动补 `turn/end`）。状态指针已改 M2 待开始。
- M1 落地物：`@mini-dsh/session`（五种词汇事件 + session/created 头记录、Session 桥接
  append-only 日志、SessionPersistence seam + JSONL 后端、SessionManager create/resume/list、
  崩溃恢复 repairDanglingTurn）、可复用 seam 契约测试套件（`tests/contracts/`）、演示
  `roundtrip.ts` + 教程练习 `my-crash.ts`/`my-resume.ts`、教程 `docs/tutorials/M1-event-log.md`。
- 过程中按 TDD 修掉两个真 bug：①并存会话串台（共享 EventsService，会话改用自有实例隔离）；
  ②断尾契约从"末尾恰为 turn/start"修正为"有未配对的 turn/start"。关键决策已归档：
  `implemented/architecture/2026-08-16-m1-session-日志决策.md`。
- 与 spec 的偏差记录：示例脚本放 `packages/session/examples/`（沿用 M0 包内 examples 约定），
  而非 spec 里的根级 `examples/`。

## M0 完成快照（2026-08-16 增补）

- **状态**：M0 已实现并通过验收（空 profile 启动、ctx 注入测试服务、23 个测试全绿、typecheck 绿、
  demo 可跑、教程交付并实测小白练习）。状态指针已改 M1 待开始。
- M0 落地物：monorepo 骨架（pnpm workspaces + bundler 解析 + vitest 单根配置）、
  `@mini-dsh/test-support`（createTestContext / defineTestService / createEventRecorder）、
  `@mini-dsh/kernel`（parseProfile / loadProfile / startProfile + setup 钩子 + app/ready|stop 词汇）、
  `examples/hello-profile` demo、两个包的教学 README、教程 `docs/tutorials/M0-kernel-and-plugins.md`。
- M0 关键技术决策（cordis@4.0.0-rc.8、bundler 解析、模块增强类型化、profile 格式、pnpm allowBuilds）
  已归档：`implemented/architecture/2026-08-16-m0-技术决策.md`。
