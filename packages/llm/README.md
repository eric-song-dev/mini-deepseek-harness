# @mini-dsh/llm

**LLM seam + OpenAI 兼容 adapter**（默认对接 DeepSeek API；Ollama/vLLM 等端点通用）。

这是本项目的**第二个 seam**（第一个是 `@mini-dsh/session` 的 SessionPersistence）。M1 定义了"会话
是什么"（日志），这个包定义"日志里的 assistant 内容是谁生成的"（模型）。

## 为什么是 seam

agent loop（`@mini-dsh/agent`）只认 `LLM` 这套契约，不关心背后是谁在回答：

- **OpenAI 兼容 adapter**（本包）—— 生产实现：DeepSeek 官方 API、Ollama、vLLM 都走同一协议，
  换端点只改插件的 `baseUrl`/`model`。
- **假 LLM**（`@mini-dsh/test-support`）—— 测试实现：预设台词本，零 key、零网络、可复现。

"换 provider = 换提供 `llm` 服务的插件，loop 一行不改" —— seam 的意义就在这句话里。
将来做多 provider registry（backlog），也是挂在这条 seam 上。

## 契约（`src/llm.ts`）

```ts
interface LLM {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>
}
```

- `ChatMessage { role: 'system'|'user'|'assistant', content }` —— 与 session 包的
  `ProjectedMessage` 结构相同，loop 把日志投影直接当模型输入。
- `ChatResult { content, usage: { inputTokens, outputTokens } }` —— token 用量是 M5 Trajectory
  检查器的数据来源，adapter 必须透传。
- `ChatOptions.onChunk?` —— **M4 流式 UI 的预留缝**：M2 的 loop 只消费非流式，adapter 与假 LLM
  都不调用它。M4 接 UI 时用同一个 seam，不用改契约。

任何实现都必须通过 `tests/contracts/llm-contract.ts` 的契约测试（结果 shape、messages 顺序、
错误以 rejection 传播）。现在有两个实现通过：adapter（假 HTTP 端点）与假 LLM。

## adapter（`src/openai.ts`）

- `createOpenAiLlm({ baseUrl?, apiKey?, model?, fetch? })`：POST `<baseUrl>/chat/completions`，
  body `{ model, messages, stream: false }`。
  - 默认 `https://api.deepseek.com` + `deepseek-chat`（DeepSeek API 就是 OpenAI 兼容协议）。
  - `apiKey` 可选：提供时带 `Authorization: Bearer`；Ollama/vLLM 本地端点无需 key，留空即可。
  - `fetch` 可注入：**测试注入假 HTTP 端点，零 key 不真调 API**。
- 响应解析：`choices[0].message.content` + usage 映射（`prompt_tokens → inputTokens` 等）。
- 非 2xx 抛 `LlmHttpError`（带状态码）；网络错误原样传播——loop 的崩溃路径靠它触发
  （`turn/end {reason:'crash'}`）。
- `openAiLlm` 插件把 adapter 注册成 `llm` 服务（JSONL 后端同款注入模式）；
  `provideLlm(llm)` 注入任意 LLM 实例（demo 与测试注入假 LLM 用——"连假模型也是一个插件"）。

## 试试（零 API key）

```bash
pnpm vitest run packages/llm   # 契约测试 + 假 HTTP 端点测试，共 13 个
```

真接 DeepSeek API 时（需要 key 与网络）：

```ts
await ctx.plugin(openAiLlm, { apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat' })
```

## 测试

| 文件 | 内容 |
|---|---|
| `tests/contracts/llm-contract.ts` | seam 契约套件（任何实现都必须通过） |
| `tests/llm-contract.test.ts` | 假 LLM 跑契约套件 |
| `tests/adapter.test.ts` | 假 HTTP 端点：请求体组装、响应解析、错误传播、注入插件；adapter 跑契约套件 |
