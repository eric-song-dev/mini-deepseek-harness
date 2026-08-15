# @mini-dsh/agent

**agent loop：全仓唯一的"拿输入→调模型→写输出"具体循环逻辑。**

M1 定义了日志（容器），M2 的 llm 包定义了模型（生产者），这个包把两者接起来：loop 是**日志的
第一个、也是唯一的生产者**——它驱动一轮对话，每个动作都落会话日志。未来的一切能力（M3 工具、
审批、compaction）都从 seam 挂进来，**不改 loop**（requirements §2.5）。

## 一轮的完整过程

```
loop.chat('你好')
  → emit turn/start                     # 轮次开始
  → emit user {content:'你好'}          # 用户消息（loop 自己记录进日志）
  → 从 session-log 读日志快照 → projectMessages 投影成模型 messages
  → llm.chat(messages)                  # 调模型（seam，换 provider = 换插件）
  → emit assistant {content:...}        # 助手回复
  → emit turn/end {reason:'done'}       # 轮次结束
```

日志顺序恒为 `turn/start → user → assistant → turn/end`（与 M1 演示约定一致）。

## 三个设计要点

1. **输入也读日志**：loop 不自己维护"消息数组"。每轮从会话 ctx 的 `session-log` 服务（M2 给
   Session 加的只读日志入口）拿快照投影成 messages——"日志是真源"的双向验证：输出写日志，
   输入读日志。resume 后历史天然完整（端到端测试守护：重启后模型看到的 messages 含重启前的
   全部问答）。
2. **loop 是插件，挂在会话 ctx 上**：`session.ctx.plugin(agentLoop, { systemPrompt? })`。
   `inject: ['llm']` 声明依赖（SessionManager 的 `static inject` 同款机制），LLM 服务由根 ctx
   提供。因为 cordis 会给插件一个会话 ctx 的**子 ctx**（自己的 fiber 作用域），loop 句柄挂在
   那个 ctx 上：

   ```ts
   const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '……' })
   const loop = fiber.ctx['agent-loop']   // 类型增强见 src/loop.ts
   await loop.chat('你好')
   ```

3. **崩溃路径可观测**：`llm.chat` rejection → emit `turn/end {reason:'crash'}` 并把原错误向上抛
   ——不吞错、不虚构 assistant 内容。M1 的崩溃恢复补的正是这条记录的同款 reason。

另外：并发 `chat` 会被内部 promise 链**串行化**（一轮未结束不开始下一轮，两轮日志不会交错）。

## 明确不做（防越界，M2）

- 工具调用循环 → M3（loop 已留好位置：assistant 之后、turn/end 之前）。
- 流式消费 → M4 接 UI（seam 的 `onChunk` 已预留）。
- 多轮上下文管理/compaction → backlog。

## 试试（零 API key）

```bash
pnpm demo:agent --clean   # 台词本三幕：聊一轮 → 同进程第二轮 → 重启 resume 续聊
```

## 测试

| 文件 | 内容 |
|---|---|
| `tests/loop.test.ts` | turn 序列、模型输入 == 日志投影、systemPrompt、多轮、崩溃、串行化、resume 历史、并存会话隔离 |
| `tests/e2e.test.ts` | 最小 runtime（JSONL+SessionManager+假 LLM+loop）聊一轮落盘 → 模拟重启 resume → 历史完整可继续 |
