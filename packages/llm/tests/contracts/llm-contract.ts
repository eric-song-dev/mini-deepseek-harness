import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, LLM } from '@mini-dsh/llm'

/**
 * LLM seam 的契约测试：任何实现（OpenAI 兼容 adapter、假 LLM、将来的本地模型）都必须全部通过。
 * 使用方式：`runLlmContract({ make, makeFailing, lastMessages })`，每份实现提供自己的 harness。
 */
export interface LlmContractHarness {
  /** 每个用例创建一个能正常回复的实现。 */
  make: () => LLM
  /** 每个用例创建一个必失败实现（chat 一定以 rejection 结束）。 */
  makeFailing: () => LLM
  /** 取回最近一次 chat 收到的 messages（顺序断言用）。 */
  lastMessages: (llm: LLM) => readonly ChatMessage[] | undefined
}

export function runLlmContract(harness: LlmContractHarness): void {
  let llm: LLM
  beforeEach(() => {
    llm = harness.make()
  })

  describe('LLM seam 契约（任何实现都必须通过）', () => {
    it('chat 返回 content 字符串与 usage 数字（input/output 均非负）', async () => {
      const result = await llm.chat([{ role: 'user', content: '你好' }])
      expect(typeof result.content).toBe('string')
      expect(typeof result.usage.inputTokens).toBe('number')
      expect(typeof result.usage.outputTokens).toBe('number')
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0)
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0)
    })

    it('messages 按给定顺序与内容原样传给实现', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '回答一' },
        { role: 'user', content: '第二句' },
      ]
      await llm.chat(messages)
      expect(harness.lastMessages(llm)).toEqual(messages)
    })

    it('调用失败以 rejection 传播（不吞错、不静默返回）', async () => {
      const failing = harness.makeFailing()
      await expect(failing.chat([{ role: 'user', content: 'x' }])).rejects.toThrow()
    })
  })
}
