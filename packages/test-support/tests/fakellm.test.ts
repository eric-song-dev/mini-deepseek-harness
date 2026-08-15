import { describe, expect, it, vi } from 'vitest'
import { createFakeLlm, FakeLlmExhaustedError } from '@mini-dsh/test-support'

describe('createFakeLlm（假 LLM，M2）', () => {
  it('按调用顺序弹出预设回复', async () => {
    const llm = createFakeLlm({ replies: [{ content: '第一句' }, { content: '第二句' }] })
    await expect(llm.chat([{ role: 'user', content: 'a' }])).resolves.toMatchObject({ content: '第一句' })
    await expect(llm.chat([{ role: 'user', content: 'b' }])).resolves.toMatchObject({ content: '第二句' })
  })

  it('记录每次调用收到的 messages（顺序与内容快照）', async () => {
    const llm = createFakeLlm({ replies: [{ content: 'ok' }] })
    const messages = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ] as const
    await llm.chat(messages)
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]!.messages).toEqual(messages)
  })

  it('回复用尽时抛 FakeLlmExhaustedError（含第几次调用），且该次请求仍被记录', async () => {
    const llm = createFakeLlm({ replies: [{ content: '唯一' }] })
    await llm.chat([{ role: 'user', content: '1' }])
    await expect(llm.chat([{ role: 'user', content: '2' }])).rejects.toThrow(FakeLlmExhaustedError)
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1]!.messages).toEqual([{ role: 'user', content: '2' }])
  })

  it('remaining 返回未弹出的回复数', () => {
    const llm = createFakeLlm({ replies: [{ content: 'a' }, { content: 'b' }] })
    expect(llm.remaining).toBe(2)
  })

  it('delay 在回复前生效（回复在延迟结束后才 resolve）', async () => {
    vi.useFakeTimers()
    try {
      const llm = createFakeLlm({ replies: [{ content: '慢回复', delay: 50 }] })
      const pending = llm.chat([{ role: 'user', content: 'x' }])
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(49)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ content: '慢回复' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('usage 默认 input/output 均为 1，可用预设回复覆盖', async () => {
    const llm = createFakeLlm({
      replies: [{ content: 'a' }, { content: 'b', usage: { inputTokens: 7, outputTokens: 3 } }],
    })
    await expect(llm.chat([{ role: 'user', content: '1' }])).resolves.toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await expect(llm.chat([{ role: 'user', content: '2' }])).resolves.toMatchObject({
      usage: { inputTokens: 7, outputTokens: 3 },
    })
  })
})
