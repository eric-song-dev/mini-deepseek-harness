import { describe, expect, it } from 'vitest'
import { createToolRegistry } from '@mini-dsh/tools'
import { syncTools } from '../src/tools'
import type { McpCallToolResult, McpClientLike } from '../src/tools'

/**
 * executor 与结果映射契约（T5）：执行闭包持有 rawName，公开名绝不发服务器；
 * text 块 '\n' 连接、非文本块变占位符（上游同款文案）；isError 是**结果**不是
 * 异常（mini 纪律：模型看到 { isError, content } 可自行纠正）；仅 transport 级
 * 失败 throw（→ loop 的 turn/end(crash) 路径）。input 非对象兜底 {}。
 */

interface Call {
  name: string
  arguments?: Record<string, unknown>
}

/** 按调用序依次返回预设结果的假 client。 */
function fakeClient(responses: Array<McpCallToolResult | Error>) {
  const calls: Call[] = []
  const client: McpClientLike = {
    async listTools() {
      return { tools: [{ name: 'probe', description: '探针' }] }
    },
    async callTool(params) {
      calls.push(params)
      const response = responses.shift()
      if (response instanceof Error) throw response
      if (response === undefined) throw new Error('假 client 台词耗尽')
      return response
    },
  }
  return { client, calls }
}

/** 注册名为 probe 的 MCP 工具（公开名 mcp__srv__probe），返回可执行注册表。 */
async function registryWithProbe(responses: Array<McpCallToolResult | Error>) {
  const tools = createToolRegistry()
  const { client, calls } = fakeClient(responses)
  await syncTools(client, tools, 'srv', new Map())
  return { tools, calls }
}

const text = (t: string): McpCallToolResult => ({ content: [{ type: 'text', text: t }] })

describe('MCP 工具 executor 与结果映射', () => {
  it('成功：text 块以换行连接为单个字符串', async () => {
    const { tools } = await registryWithProbe([
      { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
    ])
    const output = await tools.execute('mcp__srv__probe', {}, { cwd: '/' })
    expect(output).toEqual({ content: '第一行\n第二行' })
  })

  it('rawName 只走 wire：callTool 收到的是服务器原始名（公开名绝不外发）', async () => {
    // 工具注册名是公开名 mcp__srv__probe，wire 上必须是 raw 名 probe
    const { tools, calls } = await registryWithProbe([text('ok')])
    await tools.execute('mcp__srv__probe', { a: 1 }, { cwd: '/' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('probe')
  })

  it('参数原样透传（JSON 参数对象逐字上 wire）', async () => {
    const { tools, calls } = await registryWithProbe([text('ok')])
    await tools.execute('mcp__srv__probe', { path: '/tmp/x', content: 'hi' }, { cwd: '/' })
    expect(calls[0]!.arguments).toEqual({ path: '/tmp/x', content: 'hi' })
  })

  it('image/audio/resource/未知块变为占位符（文本与占位符同框连接）', async () => {
    const { tools } = await registryWithProbe([
      {
        content: [
          { type: 'text', text: '看图：' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
          { type: 'audio', mimeType: 'audio/mp3' },
          { type: 'resource' },
          { type: 'weird-block' },
        ],
      },
    ])
    const output = await tools.execute('mcp__srv__probe', {}, { cwd: '/' })
    expect(output).toEqual({
      content: [
        '看图：',
        '[image: image/png, content discarded]',
        '[audio: audio/mp3, content discarded]',
        '[resource: content discarded]',
        '[unsupported content type: weird-block]',
      ].join('\n'),
    })
  })

  it('isError:true 是结果不是异常：返回 { isError, content } 让模型看到失败原因', async () => {
    const { tools } = await registryWithProbe([{ content: [{ type: 'text', text: '文件不存在' }], isError: true }])
    const output = await tools.execute('mcp__srv__probe', {}, { cwd: '/' })
    expect(output).toEqual({ isError: true, content: '文件不存在' })
  })

  it('空内容 → 带工具名的兜底文案', async () => {
    const { tools } = await registryWithProbe([{ content: [] }])
    const output = await tools.execute('mcp__srv__probe', {}, { cwd: '/' })
    expect(output).toEqual({ content: '(probe returned no text content)' })
  })

  it('input 不是对象（模型给了裸 JSON 值）→ 兜底 {} 让服务器给出缺参错误', async () => {
    const { tools, calls } = await registryWithProbe([text('ok')])
    await tools.execute('mcp__srv__probe', '裸字符串' as never, { cwd: '/' })
    expect(calls[0]!.arguments).toEqual({})
  })

  it('transport 级失败（callTool reject）原样抛出——走 loop 的 crash 路径', async () => {
    const { tools } = await registryWithProbe([new Error('Not connected')])
    await expect(tools.execute('mcp__srv__probe', {}, { cwd: '/' })).rejects.toThrow('Not connected')
  })
})
