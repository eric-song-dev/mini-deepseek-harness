# @mini-dsh/subagent

**Subagents seam（M8）**：让一个 agent 把工作委派给**子 agent**，以及面向模型的
`subagent` 委派工具。与 bash 一样，它是**可选能力**，不属于 agent loop——loop 一行
专属逻辑都没有（只在 ToolContext 里透传会话 ctx）。

## 为什么有这个包

前七个里程碑的 agent 只会自己干活：一次对话、一套工具、一个会话日志。**subagent 让
"一个 agent"变成"一个能招人的 agent"**：父 agent 把一块自包含的子任务（调研、一块
scoped 实现、一次分析）派给子 agent——子 agent 有自己的会话、自己的工具往返、自己
的轨迹，父 agent 只拿回结果。这就是原版多智能体编排（subagent / workflow）的
mini 第一层。

## 三个部分

| 模块 | 是什么 | 为什么 |
|---|---|---|
| `SubagentRuntime`（`ctx.subagents`） | **具名 provider 注册表**：`registerProvider / getProvider / list / start(name, request)` | 与 bash 的"每 ctx 单执行器"不同，这里**多实现共存按名路由**（上游 LLM 适配器注册表模式）：spawn/fork 两个传输，换传输不改调用方 |
| `spawn` / `fork` 提供方 | 进程内子 agent 传输：子会话 = 独立 Session + agentLoop（继承根 ctx 的 llm/tools） | spawn 空对话开始；fork 以父日志"平衡已完成轮次前缀"为种子——子 agent 看得到父历史，看不到进行中的轮次 |
| `subagent` 工具 | tools seam 里的普通工具：前台 await 子 run + 总是 dispose | 模型按需委派；跟随 provider 生命周期挂/摘（sibling 加载顺序无关） |

## 关键语义（"result 失败不 reject"）

- **单次 run**：`start()` 兑现 = 子 agent 已发布（子会话已建好、loop 已装好）；拒绝 =
  未发布资源已清理、不 emit 事件对。`run.id` == 子会话 id。
- **`SubagentRun.result` 失败不 reject**：子级失败（模型 crash / 工具步数超限）以非
  `completed` 的 `stopReason`（`completed|aborted|error`）resolve——消费方把非
  completed 映射为 isError 工具结果，**截断的回答不冒充成功**（错误消息带保留的部分
  输出）。
- **输出选取**：子 agent 最后一条**非空** assistant 文本（fork 时排除种子边界，绝不
  把父历史当子输出）。
- **只观察不落父日志**：`subagent/start` / `subagent/end`（按 runId 配对）emit 在
  **父会话 ctx 的隔离事件总线**（Session 给每会话独立 EventsService——上游
  scope-filtered 的 mini 对应物）；`subagent/provider-added/removed` 是服务 ctx 上的
  注册表事件。父会话只多 tool 调用/结果事件（结果含子会话 id）。
- **注册可逆（M6）**：`registerProvider` 返回幂等撤销函数；移除 provider 阻止新
  start，但不撤销已返回给持有方的 run。HMR-safety 测试守护。

## 已知限制（mini 裁掉什么）

- 无中途取消：mini 的 loop 没有 cancel，signal 只在启动前生效，`dispose()` =
  "等结果停稳后释放子会话"（上游 worker-thread 隔离与可继续后台子 agent 是解决
  路径，留 backlog）；
- 深度只记账不设限（`SessionMeta.parentSessionId` + `depth`）；能力矩阵
  （outputSchema/toolFilter/persona/depthLimit）整体砍掉。

## 使用

```ts
// 1. seam + 传输：spawn 提供方（默认名 spawn；fork 同理）
await ctx.plugin(SubagentRuntime)
await ctx.plugin(spawnProvider)
// 2. 面向模型的工具：provider 在时自动挂载
await ctx.plugin(toolSubagent)
```

教程：`docs/tutorials/M8-subagent-workflow.md`；demo：`pnpm demo:subagent`。
