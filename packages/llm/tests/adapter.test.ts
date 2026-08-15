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
  beforeEach(() => {
    http = createFakeHttp(() => ({ body: okCompletion }))
  })
  runLlmContract({
    make: () => createOpenAiLlm({ apiKey: 'k', fetch: http.fetch }),
    makeFailing: () =>
      createOpenAiLlm({ fetch: createFakeHttp(() => ({ status: 500, body: {} })).fetch }),
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
    { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ]

  function lastBody(http: FakeHttp): Record<string, unknown> {
    return JSON.parse(http.calls.at(-1)!.init.body as string) as Record<string, unknown>
  }

  it('请求带 tools 声明：type:function 包裹，name/description/parameters 透传；未传 tools 时无该字段', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    await llm.chat([{ role: 'user', content: 'x' }], { tools })
    expect(lastBody(http).tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ])
    await llm.chat([{ role: 'user', content: 'x' }])
    expect('tools' in lastBody(http)).toBe(false)
  })

  it('assistant 的 toolCalls 序列化为 tool_calls（arguments 转 JSON 串）；tool 消息序列化为 role:tool + tool_call_id', async () => {
    const http = createFakeHttp(() => ({ body: okCompletion }))
    const llm = createOpenAiLlm({ fetch: http.fetch })
    const messages: ChatMessage[] = [
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ content: '文件内容' }) },
    ]
    await llm.chat(messages)
    expect((lastBody(http).messages as unknown[]).slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
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
