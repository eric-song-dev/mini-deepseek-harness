# @mini-dsh/session

教学定位：**"事件日志是真源"（requirements §2.3）的落地**。本包定义会话的事件词汇、
append-only 日志、持久化 seam 与 JSONL 后端 —— agent loop（M2）每走一步都要往这里落事件，
Trajectory（M5）从这里投影出视图。

## 为什么词汇先于 loop

顺序是有意的：M2 的 loop 每产生一个动作（用户消息、助手回复、工具调用）都必须**有处安放**，
M5 的轨迹视图要**有处投影**。所以 M1 先把"会话长什么样"定下来：一个会话就是一段
append-only 的 `SessionEvent` 序列，loop 只是产生这段序列的来源之一。

## 词汇表（事件名 = 日志条目的 type）

| 事件名 | 载荷 | 含义 |
|---|---|---|
| `turn/start` | 无 | 一轮对话开始 |
| `turn/end` | `{ reason: 'done' \| 'user' \| 'crash' \| 'limit' }` | 一轮对话结束；`crash` 由崩溃恢复补写，`limit` 是 M3 的步数超限 |
| `user` | `{ content: string }` | 用户消息到达 |
| `assistant` | `{ content: string, toolCalls?, usage? }` | 助手回复；M3 起回复可能是"要工具"（带 toolCalls）；M5 起带 token 用量（旧日志无此字段） |
| `tool` | `{ name, input, output? }` | 工具调用：一次调用落两条（调用无 output、结果带 output） |

另外有**头记录** `session/created`（`seq: 1`，payload 是会话 meta）：它由持久化 `create`
直接写入文件首行，**不是 emit 出来的** —— 这是日志里唯一不来自事件的记录（"创世记录"）。

词汇用 cordis 模块增强写进类型系统（`src/events.ts`）：`ctx.emit('foo/bar')` 是编译错误，
`ctx.emit('user', {...})` 的载荷有精确类型。事件**运行时**始终走 cordis 事件总线，类型只是增强。

## 核心设计：emit → append 桥接

agent/测试插件在**会话自己的 ctx** 上 emit 词汇事件，`Session` 内部的桥接监听器把事件
**同步**追加进 append-only 日志（内存 + 持久化）。emit 方不知道谁在记录、也不直接碰日志。

为什么不是"直接调 `session.append()`"？那样会有两条行为路径（emit 一条、append 一条），
UI 和测试就统一不了"看事件"。桥接保证：**日志内容 == 事件流的完整镜像**。

## append-only 与真源

- `session.log` 对外只读（`readonly SessionEvent[]`），没有修改/删除 API —— 类型层就删不掉。
- 内存日志是**投影**，文件是**持久化形态**，两者由桥接保证一致；没有任何"数据库行 + UI 状态"
  的第二套真相。
- 崩溃恢复演示了日志为真的力量：进程被杀死后，光凭日志本身就能发现"这轮对话没说完"，
  resume 时补一条 `turn/end { reason: 'crash' }` 让日志重新闭合（幂等：补过就不再补）。

## seam：SessionPersistence + JSONL 后端

持久化是抽象服务 `session-persistence`，契约五件套：`locate` / `create` / `append` /
`load` / `list`。JSONL 是第一个实现，SQLite（backlog #4）只需另写一个实现、通过同一份
契约测试（`tests/contracts/persistence-contract.ts`），`SessionManager` 一行不改 ——
这就是 seam 的意义。

**为什么 JSONL 而非 SQLite**：教学目标是看清"日志就是日志"——每行一条 JSON、追加写、
肉眼可读；SQLite 把这个事实藏进 B-tree 里。M1 的规模根本用不上查询能力（那是 backlog 的事）。

**为什么单文件追加、不做事务**：崩溃窗口（写了半行/写了一半）由恢复逻辑兜底 ——
`load` 按行解析，坏行报错、断尾补 `turn/end`。用"恢复兜底"换掉"事务复杂度"，
对教学项目是划算的取舍（真实系统会两样都要）。

文件布局：每个会话一个 `<dir>/<id>.jsonl`；`dir` 默认 `<DSH_HOME 或 ./.mini-dsh>/sessions`，
可经 `JsonlOptions.dir` 覆盖。首行 `session/created`，之后每行一条 `SessionEvent`，
`seq` 单调递增。

## 会话隔离（踩过的坑）

cordis 的子 ctx 沿原型链**共享**根 ctx 的事件总线实例。若不处理，同一 runtime 下两个并存
会话的桥接会互相收到对方的 emit（串台 —— 演示脚本一度因此把 A 会话的事件写进 B 会话）。
`Session` 构造时给会话 ctx 定义了**自己的 `EventsService` 实例**（`Object.defineProperty`
覆盖继承来的共享实例）：会话事件只在会话自己的 ctx 内可见。代价是根 ctx 听不到会话内部
事件 —— 对本架构无损失，因为真源是日志，观察者读日志而不是听总线。

## API

- `openSession(parentCtx, config)` → `Session`：会话本身也是一个插件（"一切皆为插件"连会话
  也不例外）——挂到 parent 上，得到自己的子 ctx（继承根的服务）与独立 fiber 生命周期。
- `Session`：`ctx`（emit 词汇事件的入口）、`log`（只读日志）、`flush()`（等待落盘）、
  `dispose()`（落盘排空 + 摘除桥接）。
- `SessionManager`（cordis `Service`，`inject: ['session-persistence']`）：`create` /
  `resume`（含崩溃修复）/ `list`。
- `repairDanglingTurn(events)`：崩溃修复的纯函数核心（有未配对的 `turn/start` → 补
  `turn/end`），单独导出方便教学与测试。
- `createJsonlPersistence(options)` / `jsonlPersistence(ctx, options)`：后端工厂 / 插件。

### M2 增量：日志的两个新入口

- **`session-log` 服务**（会话 ctx 上的只读属性，`ctx['session-log'].events`）：M2 的 loop
  从这里读日志快照做投影——"输出写日志、输入读日志"的输入侧通道（M5 的 Trajectory 视图也是
  从这个真源读）。快照是副本，改不动日志。实现用 `Object.defineProperty` 自有属性遮蔽而非
  `ctx.provide`：cordis 服务键按**根 ctx 作用域唯一**，并存会话各自 provide 会撞键
  （同 `events` 的处理，见"会话隔离"）。
- **`projectMessages(events, { systemPrompt? })`**：日志 → 模型消息数组的投影（M1 预告的
  投影第一次落地）。user/assistant 事件按日志顺序映射、其余跳过、systemPrompt 拼头部；
  M5 的 Trajectory 投影是同一真源上的另一个视图。

### M3 增量：工具历史进投影 + 会话 cwd

- **`projectMessages` 支持工具历史**：assistant 的 `toolCalls` 原样映射；tool **结果事件**
  映射成 `role:'tool'` 消息（content = `JSON.stringify(output)`，toolCallId 按"最近的
  assistant toolCalls 顺序"配对；孤立结果合成 `tool-<seq>` id）；tool **调用事件**（无
  output）跳过——结果没回来，模型不能看到半截。
- **`session-meta` 入口**（会话 ctx 上的只读属性，`ctx['session-meta']`）：M3 的 loop 从它
  取工具执行的 cwd（`meta.cwd`，旧会话缺省由消费方兜底进程 cwd）。与 session-log 同款
  `defineProperty` 遮蔽。
- **`SessionMeta.cwd?`**：会话工作目录（M3 spec 决策 7）。`SessionManager.create({ cwd })`
  记入 JSONL 头记录——M1 的头记录格式天然兼容，旧会话 resume 时字段缺省。

### M8 增量：会话谱系 + fork 种子

- **`SessionMeta.parentSessionId?` / `depth?`**：subagent 子会话的谱系（谁派生的我、
  第几层委派），只记账不设限；`SessionManager.create({ parentSessionId, depth })`
  记入 JSONL 头记录，旧会话缺省 = 顶层会话。
- **`create({ seed })`**：fork 提供方把父日志的"平衡已完成轮次前缀"（截至最后一个
  `turn/end` 的轮次事件，不含父头记录）作为子会话初始历史。manager 负责把种子 seq
  平移（子头记录占 seq 1，种子变 2..N+1），后端按原样写盘——resume 重放同前缀、
  继续追加 seq 连续。

### M5 增量：轨迹投影 + usage 落日志

- **`projectTurns(events)`**（`src/turns.ts`）：输出侧投影——按轮分组
  `{ index, userText, startedAt, endedAt, durationMs, endReason, events }`，轮内事件带
  `seq/type/ts/durationMs/payload` 摘要；连续分片聚合一行（`{ chunks, joined }`）；断尾轮
  按 M1 修复语义投影成 `endReason: 'crash'`。与 `projectMessages` 成对：同一份日志、两个
  消费者。轨迹面板（client）、demo、测试共用。
- **`AssistantEventPayload.usage?`**：M5 起 loop 把 `llm.chat` 的 usage 写进 assistant
  事件（类型在 session 本地定义、与 llm 包结构化兼容——session 不依赖 llm）。旧日志无此
  字段，投影与检查器兜底显示 `—`。

## 试试（零 API key）

```sh
pnpm demo:session --clean            # 默认写到 ./.mini-dsh/sessions
pnpm demo:session --dir /tmp/sessions --clean   # 换目录看文件布局
```

三幕演示：正常会话落盘 → 模拟崩溃（turn/start 后进程退出）→ "重启"后 resume，
正常会话历史完整回放、崩溃会话自动补上 `turn/end {"reason":"crash"}`。教程
`docs/tutorials/M1-event-log.md` 的动手练习以此为基础。

## 测试

- `tests/events.test.ts`：词汇契约（emit 顺序、载荷无损、类型层 `@ts-expect-error`）。
- `tests/session.test.ts`：桥接契约（append-only、seq 递增、dispose 摘除、多会话不串台）。
- `tests/persistence.test.ts` + `tests/contracts/persistence-contract.ts`：seam 契约套件
  （未来直接复用于 SQLite 后端）+ JSONL 实现细节。
- `tests/manager.test.ts`：create / resume / list 与"模拟重启"。
- `tests/repair.test.ts` + `tests/crash-recovery.test.ts`：断尾契约（纯函数 + 端到端幂等）。
- `tests/project.test.ts`（M2）：messages 投影契约。
- `tests/session-log.test.ts`（M2）：session-log 只读入口（快照副本、并存会话互不串）。
- `tests/turns.test.ts`（M5）：轨迹投影契约（轮切块/耗时/分片聚合/断尾/旧日志兜底）。
- `tests/my-turns.test.ts`（M5 教程练习）：projectTurns 断言的红绿翻转。
