---
name: pre-push-checks
description: 在 mini-deepseek-harness 分支上 push 之前（或声称检查通过之前）使用——挑选能覆盖本次出站 diff 的最小测试与检查集，而不是反射式地跑全套；改历史（rebase）后的 push 要按租约保护流程执行。
---

# mini-deepseek-harness push 前检查

push 前把相关的本地证据跑**一次**。唯一的例外是改历史后的 push：改写与发布是一步完成的，没法在中间插入本地验证——发布后立即验证，证据不过之前不合并。本项目没有 git hooks 与 CI 矩阵（教学仓库），所以"push 前检查"是唯一的门禁：**测试 + typecheck 是你在本地能有的全部证据。**

## 检查出站变更

1. 确认检出的分支与仓库根。

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. 明确基线，检查完整范围。

```sh
git diff --stat <base>..HEAD   # 提交的部分
git status --short             # 工作区未提交的部分
```

基线必须是当前可验证的 ref（如 `origin/main` 或合并基 `git merge-base main HEAD`）；不要凭记忆猜。

## 挑选相关证据

没有放之四海皆准的本地基线。每个行为变更都要有**最窄的、能因它的回归而失败的测试或专用检查**；只有 diff 真正触及的表面才加更宽的检查。

- **包或脚本行为**：跑拥有它的 Vitest 文件或聚焦测试名：`pnpm vitest run packages/<包>/tests/<行为>.test.ts`。共享契约变化时加相邻包测试；全仓测试留给收尾时跑一次。
- **文档、notes、教程**：跑 `pnpm typecheck` 与受影响的教程练习（`pnpm tsx` / 对应 vitest 文件）；教程命令要可复制即跑。
- **模型/编辑器可见输出**：跑拥有该输出的零 key 快照或可运行示例（demo / 断言消息形状的测试）。措辞是行为，改了就要更新断言。
- **seam 契约、事件词汇、公开导出**：跑契约测试（`tests/contracts/`）+ 相关包的 typecheck，同步包 README 与教程。
- **全仓收尾**：里程碑收尾时 `pnpm test`（node+jsdom 双 workspace）+ `pnpm typecheck` 全绿。

不要因为"commit 或 push 即将发生"就手工重跑一遍刚过的检查——尤其不要为凑仪式感在 push 前重跑全量。

### 聚焦覆盖到受影响的源码

测试选择与覆盖选择是两回事。文件过滤器决定跑哪些测试；仓库配置决定度量哪些源码。需要覆盖时同时点名拥有测试与源码范围：

```sh
pnpm vitest run packages/<包>/tests/<行为>.test.ts \
  --coverage \
  --coverage.include='packages/<包>/src/**/*.ts'
```

行为真正局限于一个模块时用精确源文件。不要用 `--passWithNoTests`、调低阈值或收窄 `--coverage.include` 来掩盖没覆盖到的受影响文件。

## 完整本地预演

只有用户明确要求、诊断失败、或变更横跨全仓、没有更窄的可信集合时才跑全量（`pnpm test` + `pnpm typecheck`）。

## 保护改历史 push

单分支的 rebase 允许（含 review 之后）。改写历史前先 fetch 当前远端分支并记录它的精确 OID；用租约发布：

```sh
git push --force-with-lease=<branch>:<观测到的-oid>
```

裸 `--force` 永远不允许。没有租约保护的改写（如 `git push --force`）会在别人并发 push 时静默覆盖。

改写 push 之后，重新 fetch 活 heads，重新核对审查结论——改写前的 commit 哈希与行内注释锚点不再是有效证据。

## 处理失败

相关检查在普通 push 前失败 → 停下修好或解释清楚再走；不要 push 了赌别处能过。改写后 push 的例外：证据失败就保持已发布的 heads 不动，修复、验证修复、再发布修正。

失败看起来与环境有关时，证明它：

- 记录确切命令、失败测试与平台差异；
- 确认相关的非平台证据；
- 检查是必需的就优先修复跨平台不确定性；
- 只在用户明确要求或同意时跳过本地检查，并报告到底失败在哪、为什么别处预期不同。

## Push 流程

普通 push：

1. 选定的相关检查跑一遍。
2. 正常 commit，检查 commit 改动的文件再继续。
3. 正常 push（或授权改写时用精确租约）。
4. 核对远端 ref 与本地 `HEAD` 一致：

```sh
git rev-parse HEAD origin/$(git branch --show-current)
```

报告未决检查为未决；把失败归因给分支或环境之前先读失败本身。
