import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, LLM, ToolSpec } from '@mini-dsh/llm'

/**
 * LLM seam 的契约测试：任何实现（OpenAI 兼容 adapter、假 LLM、将来的本地模型）都必须全部通过。
 * 使用方式：`runLlmContract({ make, makeFailing, lastMessages, lastTools })`，每份实现提供自己的 harness。
 */
export interface LlmContractHarness {
  /** 每个用例创建一个能正常回复的实现。 */
  make: () => LLM
  /** 每个用例创建一个必失败实现（chat 一定以 rejection 结束）。 */
  makeFailing: () => LLM
  /** 每个用例创建一个流式实现（传 onChunk 时会逐片回调）。 */
  makeStreaming: () => LLM
  /** 取回最近一次 chat 收到的 messages（顺序断言用）。 */
  lastMessages: (llm: LLM) => readonly ChatMessage[] | undefined
  /** 取回最近一次 chat 收到的工具声明（顺序断言用）。 */
  lastTools: (llm: LLM) => readonly ToolSpec[] | undefined
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

    it('tools 声明按给定顺序原样传给实现', async () => {
      const tools: ToolSpec[] = [
        { name: 'a', description: '工具 a', parameters: { type: 'object' } },
        { name: 'b', description: '工具 b', parameters: { type: 'object' } },
      ]
      await llm.chat([{ role: 'user', content: 'x' }], { tools })
      expect(harness.lastTools(llm)).toEqual(tools)
    })

    it('带工具历史的消息序列可实现间互通（assistant+toolCalls 与 role:tool 结果消息）', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '帮我读文件' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ content: '文件内容' }) },
      ]
      const result = await llm.chat(messages)
      // 契约要点：任何实现都要能"吃下"带工具历史的消息序列并正常回复
      // （回复文本由各实现决定，不断言具体内容）。
      expect(typeof result.content).toBe('string')
    })

    it('onChunk 传入时分片按顺序回调，最终 content 为各分片拼接全文（M4 流式契约）', async () => {
      const streamed = harness.makeStreaming()
      const seen: string[] = []
      const result = await streamed.chat([{ role: 'user', content: 'x' }], {
        onChunk: (chunk) => seen.push(chunk),
      })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.join('')).toBe(result.content)
    })
  })
}
