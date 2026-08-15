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

  it('工具调用回复：result 携带结构化 toolCalls（arguments 已解析），content 默认空串', async () => {
    const llm = createFakeLlm({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
        { content: '最终回答' },
      ],
    })
    await expect(llm.chat([{ role: 'user', content: '帮我读文件' }])).resolves.toEqual({
      content: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }],
    })
    await expect(llm.chat([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: '最终回答' })
  })

  it('工具调用回复与文本回复可混排（台词本：要工具 → 要工具 → 最终回答）', async () => {
    const llm = createFakeLlm({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
        { toolCalls: [{ id: 'c2', name: 'edit', arguments: { path: 'a.txt', oldText: '旧', newText: '新' } }] },
        { content: '文件已更新。' },
      ],
    })
    const first = await llm.chat([{ role: 'user', content: 'x' }])
    const second = await llm.chat([{ role: 'user', content: 'x' }])
    const third = await llm.chat([{ role: 'user', content: 'x' }])
    expect(first.toolCalls).toEqual([{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }])
    expect(second.toolCalls).toEqual([
      { id: 'c2', name: 'edit', arguments: { path: 'a.txt', oldText: '旧', newText: '新' } },
    ])
    expect(third.toolCalls).toBeUndefined()
    expect(third.content).toBe('文件已更新。')
  })

  it('请求快照记录 tools 声明（断言 loop 给模型传了哪些工具），未传时为空数组', async () => {
    const llm = createFakeLlm({ replies: [{ content: 'ok' }, { content: 'ok' }] })
    const tools = [{ name: 'read', description: '读文件', parameters: { type: 'object' } }]
    await llm.chat([{ role: 'user', content: 'x' }], { tools })
    expect(llm.requests[0]!.tools).toEqual(tools)
    await llm.chat([{ role: 'user', content: 'x' }])
    expect(llm.requests[1]!.tools).toEqual([])
  })

  it('role:tool 结果消息与带 toolCalls 的 assistant 消息原样记录在请求快照里', async () => {
    const llm = createFakeLlm({ replies: [{ content: 'ok' }] })
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }],
      },
      { role: 'tool' as const, toolCallId: 'c1', content: '{"content":"hi"}' },
    ]
    await llm.chat(messages)
    expect(llm.requests[0]!.messages).toEqual(messages)
  })
})

describe('流式分片（M4）', () => {
  it('chunks 回复：按顺序逐片回调 onChunk，resolve 的 content 是拼接全文', async () => {
    const llm = createFakeLlm({ replies: [{ chunks: ['你', '好', '呀'] }] })
    const seen: string[] = []
    const result = await llm.chat([{ role: 'user', content: 'hi' }], { onChunk: (chunk) => seen.push(chunk) })
    expect(seen).toEqual(['你', '好', '呀'])
    expect(result.content).toBe('你好呀')
  })

  it('chunkDelay 在每片之前生效（fake timers 验证分片时序）', async () => {
    vi.useFakeTimers()
    try {
      const llm = createFakeLlm({ replies: [{ chunks: ['甲', '乙'], chunkDelay: 10 }] })
      const seen: string[] = []
      const pending = llm.chat([{ role: 'user', content: 'x' }], { onChunk: (chunk) => seen.push(chunk) })
      await vi.advanceTimersByTimeAsync(9)
      expect(seen).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(seen).toEqual(['甲'])
      await vi.advanceTimersByTimeAsync(10)
      expect(seen).toEqual(['甲', '乙'])
      await expect(pending).resolves.toMatchObject({ content: '甲乙' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('未传 onChunk：chunks 静默拼成全文（非流式环境回退）', async () => {
    const llm = createFakeLlm({ replies: [{ chunks: ['流', '式'] }] })
    const result = await llm.chat([{ role: 'user', content: 'x' }])
    expect(result.content).toBe('流式')
  })

  it('chunks 与 toolCalls 同时给是脚本错误（互斥语义，早失败）', async () => {
    const llm = createFakeLlm({
      replies: [{ chunks: ['a'], toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }],
    })
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/互斥/)
  })
})
