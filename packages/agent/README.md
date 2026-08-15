# @mini-dsh/agent

**agent loop：全仓唯一的"拿输入→调模型→写输出"具体循环逻辑。**

M1 定义了日志（容器），M2 的 llm 包定义了模型（生产者），这个包把两者接起来：loop 是**日志的
第一个、也是唯一的生产者**——它驱动一轮对话，每个动作都落会话日志。M3 起 loop 装上**工具调用
循环**（模型要工具 → 落 tool 事件 → 执行 → 结果回填 → 再问），未来的一切能力（审批、compaction）
都从 seam 挂进来，**不改 loop**（requirements §2.5）。

## 一轮的完整过程

```
loop.chat('你好')
  → emit turn/start                     # 轮次开始
  → emit user {content:'你好'}          # 用户消息（loop 自己记录进日志）
  → 从 session-log 读日志快照 → projectMessages 投影成模型 messages
  → llm.chat(messages, {tools: 声明列表})  # 调模型（LLM seam + Tools seam）
  → emit assistant {content, toolCalls?}   # 助手回复（M3 起可能"要工具"）
  → [模型要工具：] 对每个 toolCall：
      emit tool {name, input}              # 调用事件（只有 input）
      tools.execute(name, input, {cwd})    # Tools seam：pre hooks → execute → post hooks
      emit tool {name, input, output}      # 结果事件（带 output）
      → 再读日志 → 投影（结果成 role:tool 消息）→ 再问模型
  → emit assistant {content:...}        # 最终文字回答
  → emit turn/end {reason:'done'}       # 轮次结束
```

循环边界：模型不再要工具（正常收 assistant + turn/end）或达到 `maxSteps`（默认 8，落
`turn/end {reason:'limit'}` + 抛 `MaxStepsExceededError`——不静默空转）。单步单个工具串行执行，
多工具并行是 backlog。

## 四个设计要点

1. **输入也读日志（含循环内部）**：loop 不自己维护"消息数组"。每轮、**每步工具往返之后**都从
   会话 ctx 的 `session-log` 服务拿快照投影成 messages——"日志是真源"的双向验证：输出写日志，
   输入读日志。工具结果之所以能回到模型，是因为它先落进了日志；resume 后历史（含工具往返）
   天然完整（e2e 测试守护）。
2. **loop 是插件，挂在会话 ctx 上**：`session.ctx.plugin(agentLoop, { systemPrompt?, maxSteps? })`。
   `inject: ['llm', 'tools']` 声明依赖（M3 起需要 tools 服务），两个服务都由根 ctx 提供。
   因为 cordis 会给插件一个会话 ctx 的**子 ctx**（自己的 fiber 作用域），loop 句柄挂在那个 ctx 上：

   ```ts
   const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '……' })
   const loop = fiber.ctx['agent-loop']   // 类型增强见 src/loop.ts
   await loop.chat('你好')
   ```

3. **工具声明不经 system prompt**：每步把 `tools.list()` 经 `ChatOptions.tools` 传给模型
   （OpenAI 兼容协议原生参数）——注册了什么工具模型自动看到什么，注册新工具零 prompt 改动。
4. **三条出口都可观测**：`llm.chat` / 工具执行 rejection → `turn/end {reason:'crash'}`；
   步数超限 → `turn/end {reason:'limit'}`；两条路径都把原错误向上抛——不吞错、不虚构内容。
   M1 的崩溃恢复补的正是 crash 同款 reason。

另外：并发 `chat` 会被内部 promise 链**串行化**（一轮未结束不开始下一轮，两轮日志不会交错）。

## 明确不做（防越界，M3）

- 审批/权限栈 → backlog（Tools seam 的 pre-execute hook 位已留好）。
- 多工具并行调用 → backlog（M3 单步单个工具串行）。
- 工具超时/取消、MCP/LSP → backlog。

## 试试（零 API key）

```bash
pnpm demo:agent --clean    # M2 台词本三幕：聊一轮 → 同进程第二轮 → 重启 resume 续聊
pnpm demo:tools --clean    # M3 台词本驱动真工具：读文件 → 改文件 → 总结（事件日志全量可见）
```

## 测试

| 文件 | 内容 |
|---|---|
| `tests/loop.test.ts` | turn 序列、模型输入 == 日志投影、systemPrompt、多轮、崩溃、串行化、resume 历史、并存会话隔离 |
| `tests/tool-loop.test.ts` | 工具循环：多步日志序列、结果回填、tools 声明透传、maxSteps(limit)、未知工具(crash)、cwd 来源、无工具回归 |
| `tests/tool-e2e.test.ts` | 端到端：真 bash/fs 读→改→答、bash 失败结果、工具往返后重启 resume |
| `tests/my-messages.test.ts` / `tests/my-tool-loop.test.ts` | M2 / M3 教程断言练习（红绿翻转） |
