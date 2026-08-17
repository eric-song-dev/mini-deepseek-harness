import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { createOpenAiLlm, LlmHttpError, openAiLlm, provideLlm } from '@mini-dsh/llm'
import type { ChatMessage, LLM } from '@mini-dsh/llm'
import { runLlmContract } from './contracts/llm-contract'

// ---- 假 HTTP 端点（零 key：测试从不真调 API）----

interface CapturedCall {
  url: string
  init: RequestInit
}

interface FakeHttp {
  fetch: typeof fetch
  calls: CapturedCall[]
}

function createFakeHttp(respond: (url: string, init: RequestInit) => { status?: number; body: unknown }): FakeHttp {
  const calls: CapturedCall[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const captured = init ?? {}
    calls.push({ url, init: captured })
    const { status = 200, body } = respond(url, captured)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

const okCompletion = {
  choices: [{ message: { content: '你好呀' } }],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
}

// ---- 假 SSE 端点（流式模拟：frames 逐帧发出，raw 走原始 SSE 文本）----

interface SseResponse {
  status?: number
  /** SSE `data:` 帧的载荷序列；自动追加 `data: [DONE]`。 */
  frames?: unknown[]
  /** 原始 SSE 文本（完全自控：注释行、event 行、分帧边界）；优先于 frames。 */
  raw?: string
}

function createFakeSseHttp(respond: (url: string, init: RequestInit) => SseResponse): FakeHttp {
  const calls: CapturedCall[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const captured = init ?? {}
    calls.push({ url, init: captured })
    const { status = 200, frames, raw } = respond(url, captured)
    const text =
      raw ?? frames?.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    // 每帧一个 enqueue：adapter 的增量读取与真实网络分片同构（不整段塞给 body）
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const lines = text.split('\n')
        for (const line of lines) controller.enqueue(new TextEncoder().encode(line + '\n'))
        controller.close()
      },
    })
    return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

function sseChunk(delta: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): unknown {
  const chunk: Record<string, unknown> = { choices: [{ delta }] }
  if (usage) chunk.usage = usage
  return chunk
}

function lastRequestMessages(http: FakeHttp): readonly ChatMessage[] | undefined {
  const call = http.calls.at(-1)
  if (!call) return undefined
  const body = JSON.parse(call.init.body as string) as { messages: ChatMessage[] }
  return body.messages
}

describe('createOpenAiLlm（OpenAI 兼容 adapter，M2）', () => {
  it('POST 到 <baseUrl>/chat/completions：model/messages 保序、stream:false、带 Bearer 头', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ baseUrl: 'http://fake.local/v1', apiKey: 'test-key', model: 'm1', fetch: http.fetch })
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]
    const result = await llm.chat(messages)

    expect(result).toMatchObject({ content: '你好呀', usage: { inputTokens: 12, outputTokens: 7 } })
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]!.url).toBe('http://fake.local/v1/chat/completions')
    expect(http.calls[0]!.init.method).toBe('POST')
    const headers = http.calls[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers.authorization).toBe('Bearer test-key')
    expect(JSON.parse(http.calls[0]!.init.body as string)).toEqual({
      model: 'm1',
      messages,
      stream: false,
    })
  })

  it('不提供 apiKey 时不带 Authorization 头（Ollama/vLLM 等本地端点场景）', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await llm.chat([{ role: 'user', content: 'x' }])
    const headers = http.calls[0]!.init.headers as Record<string, string>
    expect('authorization' in headers).toBe(false)
  })

  it('默认端点与模型：https://api.deepseek.com + deepseek-chat', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await llm.chat([{ role: 'user', content: 'x' }])
    expect(http.calls[0]!.url).toBe('https://api.deepseek.com/chat/completions')
    expect((JSON.parse(http.calls[0]!.init.body as string) as { model: string }).model).toBe('deepseek-chat')
  })

  it('非 2xx 抛 LlmHttpError（含状态码与响应片段）', async () => {
    const http = createFakeHttp(() => ({ status: 401, body: { error: { message: 'bad key' } } }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(LlmHttpError)
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 401 })
  })

  it('网络错误原样以 rejection 传播', async () => {
    const llm = createOpenAiLlm({
      fetch: async () => {
        throw new Error('network down')
      },
    })
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toThrow('network down')
  })
})

describe('OpenAI 兼容 adapter 通过 LLM seam 契约', () => {
  let http: FakeHttp
  let sseHttp: FakeHttp
  beforeEach(() => {
    http = createFakeHttp(() => ({ body: okCompletion }))
    sseHttp = createFakeSseHttp(() => ({
      frames: [
        sseChunk({ content: '甲' }),
        sseChunk({ content: '乙' }),
        sseChunk({ content: '丙' }, { prompt_tokens: 3, completion_tokens: 3 }),
      ],
    }))
  })
  runLlmContract({
    make: () => createOpenAiLlm({ apiKey: 'k', fetch: http.fetch }),
    makeFailing: () =>
      createOpenAiLlm({ fetch: createFakeHttp(() => ({ status: 500, body: {} })).fetch }),
    makeStreaming: () => createOpenAiLlm({ apiKey: 'k', fetch: sseHttp.fetch }),
    lastMessages: () => lastRequestMessages(http),
    lastTools: () => {
      const call = http.calls.at(-1)
      if (!call) return undefined
      const body = JSON.parse(call.init.body as string) as {
        tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>
      }
      return body.tools?.map((tool) => tool.function)
    },
  })
})

describe('createOpenAiLlm（工具调用协议，M3）', () => {
  const tools = [
    { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ]

  function lastBody(http: FakeHttp): Record<string, unknown> {
    return JSON.parse(http.calls.at(-1)!.init.body as string) as Record<string, unknown>
  }

  it('请求带 tools 声明：type:function 包裹，name/description/parameters 透传；未传 tools 时无该字段', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await llm.chat([{ role: 'user', content: 'x' }], { tools })
    expect(lastBody(http).tools).toEqual([
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
    ])
    await llm.chat([{ role: 'user', content: 'x' }])
    expect('tools' in lastBody(http)).toBe(false)
  })

  it('assistant 的 toolCalls 序列化为 tool_calls（arguments 转 JSON 串）；tool 消息序列化为 role:tool + tool_call_id', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    const messages: ChatMessage[] = [
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ content: '文件内容' }) },
    ]
    await llm.chat(messages)
    expect((lastBody(http).messages as unknown[]).slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"content":"文件内容"}' },
    ])
  })

  it('响应 tool_calls 解析为结构化 ToolCall（arguments JSON.parse 成对象）；非法 JSON 回退空对象', async () => {
    const http = createFakeHttp(() => ({
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
                { id: 'c8', type: 'function', function: { name: 'bash', arguments: 'not-json' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    const result = await llm.chat([{ role: 'user', content: 'x' }])
    expect(result).toEqual({
      content: '',
      usage: { inputTokens: 5, outputTokens: 3 },
      toolCalls: [
        { id: 'c9', name: 'bash', arguments: { command: 'ls' } },
        { id: 'c8', name: 'bash', arguments: {} },
      ],
    })
  })

  it('只有 tool_calls、content 为 null 的响应视为合法（content 置空串，不报缺 content 错）', async () => {
    const http = createFakeHttp(() => ({
      body: {
        choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] } }],
      },
    }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await expect(llm.chat([{ role: 'user', content: 'x' }])).resolves.toMatchObject({
      content: '',
      toolCalls: [{ id: 'c1', name: 'bash', arguments: {} }],
    })
  })
})

describe('createOpenAiLlm（流式，M4）', () => {
  it('传 onChunk 时请求 stream:true + stream_options.include_usage；不传时 stream:false 且无 stream_options', async () => {
    // 端点按请求体的 stream 字段切换响应：流式给 SSE 帧，非流式给 JSON（与真实 API 一致）
    const sseHttp = createFakeSseHttp((url, init) => ({
      frames: [sseChunk({ content: '好' })],
    }))
    const jsonHttp = createFakeHttp(() => ({ body: okCompletion }))
    const routingFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      if (body.stream === true) return await sseHttp.fetch(input, init)
      return await jsonHttp.fetch(input, init)
    }
    const llm = createOpenAiLlm({ fetch: routingFetch })
    await llm.chat([{ role: 'user', content: 'x' }], { onChunk: () => {} })
    const streamedBody = JSON.parse(sseHttp.calls.at(-1)!.init.body as string) as Record<string, unknown>
    expect(streamedBody.stream).toBe(true)
    expect(streamedBody.stream_options).toEqual({ include_usage: true })
    await llm.chat([{ role: 'user', content: 'x' }])
    const plainBody = JSON.parse(jsonHttp.calls.at(-1)!.init.body as string) as Record<string, unknown>
    expect(plainBody.stream).toBe(false)
    expect('stream_options' in plainBody).toBe(false)
  })

  it('SSE data: 帧逐帧回调 onChunk（跳过注释/event/空行），content 为拼接全文，usage 取带 usage 的帧', async () => {
    const http = createFakeSseHttp(() => ({
      raw: [
        ': keep-alive 注释行',
        '',
        'event: message',
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: {"choices":[{"delta":{"content":"呀"}}],"usage":{"prompt_tokens":9,"completion_tokens":3}}',
        '',
      ].join('\n') + '\ndata: [DONE]\n\n',
    }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    const seen: string[] = []
    const result = await llm.chat([{ role: 'user', content: 'x' }], { onChunk: (chunk) => seen.push(chunk) })
    expect(seen).toEqual(['你', '好', '呀'])
    expect(result.content).toBe('你好呀')
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 })
    expect(result.toolCalls).toBeUndefined()
  })

  it('流式 tool_calls 增量按 index 累积（id/name/arguments 跨帧拼接），arguments 解析成对象', async () => {
    const http = createFakeSseHttp(() => ({
      frames: [
        sseChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"file_path":' } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
        sseChunk({}),
      ],
    }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    const result = await llm.chat([{ role: 'user', content: 'x' }], { onChunk: () => {} })
    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('流式非 2xx 抛 LlmHttpError（含状态码）', async () => {
    const http = createFakeSseHttp(() => ({ status: 401, raw: 'data: {"error":"bad key"}\n\n' }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await expect(llm.chat([{ role: 'user', content: 'x' }], { onChunk: () => {} })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('流式结束仍无内容且无工具调用时抛缺 content 错（不静默空回复）', async () => {
    const http = createFakeSseHttp(() => ({ frames: [] }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await expect(llm.chat([{ role: 'user', content: 'x' }], { onChunk: () => {} })).rejects.toThrow(
      /缺少 choices/,
    )
  })
})

describe('llm 服务的注入插件', () => {
  it('openAiLlm 插件把 adapter 注册成 llm 服务（换 provider = 换这个插件）', async () => {
    const { ctx, dispose } = await createTestContext()
    const http = createFakeHttp(() => ({ body: okCompletion }))
    await ctx.plugin(openAiLlm, { apiKey: 'k', fetch: http.fetch })
    try {
      const llm: LLM = ctx.get('llm')!
      await expect(llm.chat([{ role: 'user', content: '在吗' }])).resolves.toMatchObject({ content: '你好呀' })
    } finally {
      await dispose()
    }
  })

  it('provideLlm 插件把任意 LLM 实例注册成 llm 服务（demo/测试注入假 LLM 用）', async () => {
    const { ctx, dispose } = await createTestContext()
    const fake = createFakeLlm({ replies: [{ content: '假回复' }] })
    await ctx.plugin(provideLlm, fake)
    try {
      const llm: LLM = ctx.get('llm')!
      await expect(llm.chat([{ role: 'user', content: '在吗' }])).resolves.toMatchObject({ content: '假回复' })
    } finally {
      await dispose()
    }
  })
})
