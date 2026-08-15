import { createFakeLlm } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { runLlmContract } from './contracts/llm-contract'

// 假 LLM 是 LLM seam 的测试实现：它必须通过 seam 契约测试，才能作为测试里的替身。
runLlmContract({
  make: () => createFakeLlm({ replies: [{ content: '契约回复' }] }),
  makeFailing: () => createFakeLlm({ replies: [] }),
  lastMessages: (llm) => (llm as FakeLlm).requests.at(-1)?.messages,
})
