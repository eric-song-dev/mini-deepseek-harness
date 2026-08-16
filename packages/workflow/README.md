# @mini-dsh/workflow

**WorkflowEngine seam（M8）**：让模型编写"会启动 subagent 的编排脚本"，以及面向模型
的 `workflow` 工具。与 subagent 一样是**可选能力**：脚本解析、执行、取消都在 seam
之后，loop 一行不感知。

## 为什么有这个包

subagent 是一次委派。当工作要**扇出**到很多块独立任务（一次多文件审计、一次迁移、
多角度调研）时，"逐条委派等结果"又慢又费上下文。workflow 让模型写一段 JS 脚本，
把协调逻辑（谁并发、谁串行、怎么收集）交给脚本、把"干活"继续交给 subagent——
**agent 干活，脚本协调**。workflow 是 subagents 之上的**消费方**：脚本每次
`agent()` = 一次 `ctx.subagents.start()`；上游 `tool-ralph` 证明"同一引擎 +
subagents"可承载专用编排策略而不改 agent loop——本包学的正是这层分层。

## 两个部分

| 模块 | 是什么 | 为什么 |
|---|---|---|
| `WorkflowEngine`（`ctx.workflowEngine`） | 同线程 `async Function` 执行脚本：meta 校验 + 脚本 parse 先行，脚本 realm 只注入 `args` + 五钩子 | 脚本只做协调：不注入 fs/网络/timer（**同线程 ≠ 沙箱**，见限制）；坏脚本在任何 agent 启动前失败 |
| `workflow` 工具 | tools seam 里的普通工具：`{ script, meta, args }` → 脚本最终 JSON 值 | description 即脚本编写契约全文（meta 块、五钩子语义、误用必杀、前台执行） |

## 脚本钩子（模型可见的契约）

- `agent(prompt, opts?)`：跑一个 subagent。返回子 agent 最终文本；子失败 → `null`。
  opts 只有 `label` / `phase`；**未知选项 → fatal 终止脚本**。
- `parallel(thunks)`：并发跑零参函数，**等全部**（屏障）。thunk 抛普通错 → 该元素
  `null`；fatal → 整体终止。
- `pipeline(items, ...stages)`：每个 item 独立走完阶段（阶段间**无屏障**），阶段收到
  `(prev, item, index)`；阶段内普通错 → 该 item `null` 并跳过剩余阶段。
- `phase(title)` / `log(message)`：观察事件；`args`：工具调用的 args 输入，逐字可见。

## 关键语义

- **fatal 纪律**：钩子误用（坏参数、未知选项、坏脚本、meta 非法、子 start 失败、取消）
  抛 `fatal: true` 的 `WorkflowError`；`parallel()`/`pipeline()` 对 fatal **直接
  re-throw**——拼错选项必须杀脚本，**绝不消融成逐项 `null`**（null 只留给子 run
  失败与普通脚本错误）。
- **`result` 从不 reject**：脚本失败 → `stopReason: 'error'`（error 文本带
  `CODE:` 前缀，机器可路由）；已接受的取消覆盖后到的非取消结果。
- **事件只观察**：`workflow/start|phase|log|agent-start↔agent-end|end` 全部 emit 在
  父会话 ctx（不落父日志）；payload 以 `WorkflowRunInfo(id+meta)` 开头；
  `workflow/end` **刻意不含 value**（观察者不得拿调用方 result 的可变别名）；
  agent 按 `seq` 配对；监听器抛错被隔离（记日志、不传播）。
- 返回值必须是纯 JSON 数据（`RESULT_UNSERIALIZABLE`）；`undefined` → `null`。

## 已知限制（mini 裁掉什么）

- **同线程 ≠ 沙箱**：`async Function` 只在当前进程执行；不注入 fs/timer 是 API 设计
  不是隔离。上游 worker-thread 引擎（每 run 一个 worker、可终止卡死脚本）是解决
  路径，mini 只读理解不照搬——`cancel()` 只在钩子 await 点生效，同步死循环无法打断。
- 无上限（maxTotalAgents / 并发控制）、无持久 `tool-workflow/*` 日志记录、无 render
  层（Web tool 卡片直接显示 JSON，故无 maxResultChars 截断）。

## 使用

```ts
// 1. 引擎（agent() 默认走 spawn 提供方）+ 2. 面向模型的工具
await ctx.plugin(WorkflowEngine)
await ctx.plugin(toolWorkflow)
```

教程：`docs/tutorials/M8-subagent-workflow.md`；demo：`pnpm demo:subagent`。
