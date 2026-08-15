---
name: tdd
description: 测试驱动开发纪律：red→green→refactor。写任何实现代码前先写一个失败的测试；适用于 mini-deepseek-harness 的所有功能代码（插件、seam 契约、工具、UI 逻辑）。
---

# TDD（测试驱动开发）

本项目所有功能代码遵循 TDD。**先测试，后实现；没有失败测试就不写实现。**

## 触发时机

- 实现任何新插件、新 seam、新工具、新事件类型
- 修复任何 bug（先写复现测试）
- 修改任何已发布契约（先改测试表达新契约）

不适用于：纯文档、README、notes 记录。

## 循环纪律

1. **RED**：写一个最小的失败测试，表达期望行为。运行它，确认它失败且失败原因符合预期（不是语法错误/配置错误）。
2. **GREEN**：写**最少**的代码让测试通过。不许顺手做测试没要求的事。
3. **REFACTOR**：测试全绿后，清理重复、改善命名与结构；测试保持绿。

每步提交一次（RED 提交、GREEN 提交、REFACTOR 提交），commit message 用中文简述行为。

## 测试约定

- 框架：Vitest。测试与被测代码同包，放 `tests/` 或 `src/__tests__/`。
- 断言优先用事件与 seam 契约，不用内部实现细节：
  - harness 测试的核心手法：创建测试 ctx → 注入假服务（如假 LLM）→ 触发行为 → **断言 session 事件日志**（顺序、词汇、载荷）。
  - seam 测试：对抽象服务写契约测试（如 `SessionPersistence` 的 locate/create/append/load），后端实现必须全部通过。
- 假 LLM：`packages/test-support` 提供可编程假 LLM（预设回复序列、工具调用序列、流式分片、延迟模拟）。
- 测试名用中文描述行为："当用户消息到达时记录 user 事件"。

## 红绿节奏的粒度

- 一个行为一个测试；不要一次测一大片。
- 卡住超过 10 分钟：缩小步长（把行为再拆一半），而不是跳过测试直接写实现。
- 禁止为了"赶进度"先写实现再补测试——这破坏的不只是测试，是日志驱动的架构验证。

## 与 notes 的配合

- 跨 session 中断时，把当前 RED/GREEN 状态写进 `.agents/notes/proposed/` 或 `implemented/`（哪个测试在红、下一个行为是什么），下个 session 先读 notes 再继续。
- 里程碑验收（见 `docs/requirements.md` §9）：有测试 + 可 demo + 有文档 + 有教程。

## DoD 检查

- [ ] 新行为有失败测试先行（commit 历史可查 RED 提交）
- [ ] 全量测试绿
- [ ] seam 契约测试已更新
- [ ] 关键决策已记入 `.agents/notes/`
- [ ] 若当前 M 收尾：入门教程已同步完成并通过"小白验收"（`docs/requirements.md` §5.1；教程本身是文档，不走红绿循环，但属于 M 验收）
