# @mini-dsh/tools

**Tools seam + 最小工具集（bash + 文件读/写/编辑）。**

这是本项目的**第三个 seam**（前两个：`@mini-dsh/session` 的 SessionPersistence、`@mini-dsh/llm`
的 LLM）。前两个 seam 回答"日志由谁持久化、assistant 内容由谁生成"，这个 seam 回答：
**loop 之外的能力从哪来**。模型只会说，工具让它会做——M3 起 agent 是"手脚俱全"的。

## 为什么是 seam

agent loop 只认 `ToolsService` 这套契约（注册表 + 执行管线），不关心工具是什么：

- 工具 = **声明**（name/description/参数 schema，给模型看）+ **实现**（`execute`，真正动手）；
- 本包的 bash/文件工具是第一批实现；未来的 MCP 工具（backlog #6）换注册表实现、审批栈
  （backlog #2）挂 pre-execute hook，**都不改 loop、不改管线**（requirements §8）。

"给 agent 加能力 = 注册一个工具"——注册了什么，loop 就自动把声明列表传给模型
（走 OpenAI 兼容协议的 `tools` 参数，不拼 system prompt）。

## 契约（`src/tools.ts`）

```ts
interface ToolsService {
  register(tool: Tool): Unregister   // M6：返回幂等撤销函数
  get(name: string): Tool | undefined
  list(): ToolDeclaration[]          // loop 每步把它传给模型
  addHook(phase: 'pre-execute' | 'post-execute', hook: ToolHook): Unregister
  execute(name: string, input, ctx: ToolContext): Promise<unknown>
}
```

执行管线三步（`execute` 内部）：

```
pre-execute hooks → execute（工具实现） → post-execute hooks
```

- **pre-execute**：执行前。M3 MVP 没有 hook = 直接放行。**这是未来审批栈的精确挂点**：
  要审批 `rm -rf` 时挂一个抛 `ToolDeniedError` 的 hook 即可。
- **post-execute**：执行后。hook 返回值替换输出（结果整形）；返回 `undefined` 表示不改。

错误契约：未知工具抛 `UnknownToolError`；pre hook 拒绝抛 `ToolDeniedError`；工具实现抛错
**原样传播**（管线不吞错）。契约测试在 `tests/contracts/tools-contract.ts`，任何实现
（默认注册表、将来的 MCP 注册表）都必须通过。

> 消费方约定（agent loop）：loop 把 `execute` 的任何 rejection 归一化成
> `{isError:true, content}` **结果**回填模型——工具错误是"结果"不是"异常"，模型看到
> 失败原因可自行纠正（与 bash 的 exit code、MCP 的 isError 同款纪律）。seam 本身仍
> 原样抛错：直接调用 `tools.execute` 的调用方拿到的还是 rejection。

## 工具集（MVP 四个）

| 工具 | 输入 | 输出 | 要点 |
|---|---|---|---|
| `bash` | `{command, cwd?}` | `{stdout, stderr, exitCode}` | **exit code 是输出不是异常**：非零退出也算"成功的结果"，模型需要看到失败原因；只有 spawn 本身失败（cwd 不存在等）才 rejection |
| `read_file` | `{path}` | 文件内容（string） | 相对路径按会话 cwd 解析；不存在**报错**（读不到就是读不到） |
| `write_file` | `{path, content}` | `{path, bytes}` | 覆盖写入；父目录自动创建（工具要能"建新东西"） |
| `edit_file` | `{path, oldText, newText}` | `{path, replaced}` | **精确替换**：旧文本必须恰好出现一次，找不到/出现多次都报错且文件不动 |

cwd 来源：会话 meta（M3 起 `SessionManager.create({ cwd })` 记入 JSONL 头记录），loop 经
`session-meta` 取到后放进执行上下文 `ToolContext.cwd`。M8 起 `ToolContext` 还带可选
`agent`（会话 ctx，loop 一行透传）：会话感知的工具（`subagent`/`workflow`）从它读
谱系/日志并把观察事件 emit 进会话隔离总线。

## ⚠️ 无沙箱（教学版，风险明示）

工具**直接执行**：bash 真的跑命令、文件工具真的读写盘，没有权限隔离与审批。模型要
`rm -rf ~` 就真会执行。这是教学取舍：沙箱是平台工程不是本项目的教学主题；风险点即教学点
（轨迹里每行都是"模型干过什么"的证据），未来审批栈闭环在 pre-execute hook 位。
**不要用真实 API key + 教学工具跑不可信输入。**

## 试试（零 API key）

```bash
pnpm vitest run packages/tools   # seam 契约 8 个 + bash/fs 共 24 个测试
pnpm demo:tools --clean          # 假 LLM 台词本驱动真工具：读 → 改 → 总结
```

## 测试

| 文件 | 内容 |
|---|---|
| `tests/contracts/tools-contract.ts` | seam 契约套件（注册表/管线顺序/拒绝位/结果整形/错误传播） |
| `tests/tools-contract.test.ts` | 默认注册表跑契约套件 |
| `tests/bash.test.ts` | bash：输出透传、exit code 非异常、cwd 解析与覆盖、spawn 失败 |
| `tests/fs.test.ts` | 文件三工具：读写往返、精确替换、路径解析、不存在报错、插件注册 |

## 注册可逆（M6）

`register` 与 `addHook` 返回**幂等撤销函数**；工具插件把撤销函数挂上 `ctx.effect`——
卸载插件即撤销注册（上游 "registrations are effects"）。守护测试：
`tests/reversibility.test.ts`（卸载 bashTool 的 fiber → 注册表为空 + `execute` 抛
`UnknownToolError`）。**给 agent 加能力 = 注册一个工具，撤能力 = 卸载那个插件。**
