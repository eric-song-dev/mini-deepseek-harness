---
name: code-review
description: 审查 mini-deepseek-harness 仓库的代码变更（diff、commit、PR）时使用——把审查者对准本仓库的标准（docs/requirements.md 硬约束、TDD 纪律、注册可逆、notes 工作流）与代码之外才能验证的检查项。
---

# 审查 mini-deepseek-harness 的代码变更

**本技能是引导，不是完整清单。** 先弄清变更的完整范围（`git status` + `git diff <base>..HEAD`），再读 diff 和足够的周边代码来理解设计。优先审查正确性、生命周期、契约与硬约束，其次才是风格；一条有实据的硬伤比一长串吹毛求疵更有价值。

## 事实来源（先读，不要凭印象）

- [docs/requirements.md](../../docs/requirements.md)：硬约束（§2：保留 CORDIS 内核、一切皆为插件、Session 事件日志是真源、Trajectory 是灵魂、可扩展性优先、注册皆可逆）、DoD（§10）、开发纪律（§11）。
- [.agents/notes/README.md](../../.agents/notes/README.md)：跨 session 决策记录工作流（proposed/implemented/rejected/archived 四目录）。
- [.agents/skills/tdd/SKILL.md](../tdd/SKILL.md)：TDD 纪律（red→green→refactor，先失败测试后实现）。
- [.agents/skills/prose-standard/SKILL.md](../prose-standard/SKILL.md)：文档与注释的覆盖要求与编辑判断。
- 对应包的 `packages/*/README.md`：seam 契约、边界行为、已知限制。
- [docs/tutorials/](../../docs/tutorials/)：每个里程碑的入门教程（读者是 AI 编程小白）——改动若影响教程中的命令或练习，教程必须同步。
- 上游参照纪律：[docs/references/upstream.md](../../docs/references/upstream.md)（照搬概念不照搬代码、一次只读一个文件）。

## 硬性要求（blocker）

1. **TDD 纪律可查**：新行为必须有失败测试先行（commit 历史里能看到 RED 提交）；测试断言事件与 seam 契约，不 restate 实现。修复 bug 先写复现测试。
2. **契约两侧同步**：改了 seam 契约（类型、语义、事件词汇）就要同步契约测试（`tests/contracts/`）与包 README；改了已发布契约先改测试表达新契约。
3. **文档与代码同 diff**：配置、默认值、错误、事件、公开行为要更新对应 README/教程；当前里程碑的教程（§5.1 六要素）随代码同节奏交付。
4. **一切注册皆可逆**（硬约束 6）：新的注册走 `register(...)` 返回幂等撤销函数 + 注册方 `ctx.effect` 挂接；每个注册表有 HMR-safety 测试（dispose 注册方 fiber → 断言注册消失）。
5. **日志是真源**：新行为若产生会话事件（turn/user/assistant/tool…），轨迹投影与回放必须覆盖它；改动事件词汇要同步 session 包与投影。
6. **证据真实存在**：作者跑过相关测试（`pnpm vitest run <文件>`）与 `pnpm typecheck`；审查者验证语义缺口（覆盖率本身不是正确性证据）。

## 手工检查项

- **意图与契约**：追踪每个改动的接口两侧。实现是否与 spec（`docs/milestones/M<n>.md`）和 notes 中的决策一致，包括错误、撤销、所有权。
- **生命周期与并发**：异步初始化、回调、卸载路径是否干净；卸载即撤销（M6 纪律）；会话落盘是否排空。
- **消费方适配**：改动 seam 时追踪所有消费方（工具、loop、webHost、client、轨迹投影）；新公开方法若只有一个内部调用方，考虑私有闭包而不是扩张 API。
- **模型视角**：检查模型实际收到的 prompt、工具 schema、工具结果、错误文案；模型可见文案是行为，改动要更新断言快照。
- **边界覆盖**：probe 空输入、超限、多字节文本、断尾/崩溃恢复路径。
- **测试强度**：断言是否会在目标回归上失败、是否观察外部状态（事件日志/落盘/撤销）而不是复述实现。

## 报告发现

说明缺陷、位置、影响与证据。局部缺陷放在最紧的 diff 行；跨切面的架构/范围问题放总评。把硬伤与建议分开；已被绿色门禁覆盖的问题不必重复列出。被审查时逐条核实，用技术依据修复或反驳，不做表演式附和。
