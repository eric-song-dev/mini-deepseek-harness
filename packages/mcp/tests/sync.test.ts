import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '@mini-dsh/tools'
import { syncTools } from '../src/tools'
import type { McpClientLike, McpListToolsResult, ToolDisposers } from '../src/tools'

/**
 * syncTools 两阶段同步契约（T4）：fetch 阶段（分页 listTools 攒齐新一代）
 * 任何失败不碰注册表；swap 阶段先 dispose 旧代再注册新代，register 冲突
 * 回滚整代（绝不半套）。client 是窄接口 McpClientLike——单测用可编程假
 * client，真实现是 @modelcontextprotocol/sdk 的 Client。
 */

/** 可编程假 client：listTools 按排好的"页"依次返回；每页可是一次失败。 */
function fakeClient(pages: Array<McpListToolsResult | Error>) {
  const listCalls: Array<{ cursor?: string }> = []
  const callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
  const client: McpClientLike = {
    async listTools(params) {
      listCalls.push(params)
      const page = pages.shift()
      if (page instanceof Error) throw page
      if (page === undefined) throw new Error('假 client 台词耗尽')
      return page
    },
    async callTool(params) {
      callToolCalls.push(params)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
  return { client, listCalls, callToolCalls }
}

function page(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>, nextCursor?: string): McpListToolsResult {
  return { tools, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

describe('syncTools 两阶段同步', () => {
  it('初始同步：发现工具注册进 Tools 注册表，声明透传，返回 disposers', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([
      page([
        { name: 'add', description: '加两个数', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } },
        { name: 'greet', description: '打招呼' },
      ]),
    ])
    const disposers = await syncTools(client, tools, 'fixture', new Map())

    const declarations = tools.list().map((d) => d.name).sort()
    expect(declarations).toEqual(['mcp__fixture__add', 'mcp__fixture__greet'])
    expect(tools.list().find((d) => d.name === 'mcp__fixture__add')?.description).toBe('加两个数')
    expect(tools.list().find((d) => d.name === 'mcp__fixture__add')?.parameters).toEqual({
      type: 'object', properties: { a: { type: 'number' } },
    })
    expect([...disposers.keys()].sort()).toEqual(['mcp__fixture__add', 'mcp__fixture__greet'])
  })

  it('raw 名绝不注册：注册表里只有 mcp__ 前缀的公开名', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([page([{ name: 'add' }])])
    await syncTools(client, tools, 'fixture', new Map())
    expect(tools.get('add')).toBeUndefined()
    expect(tools.get('mcp__fixture__add')).toBeDefined()
  })

  it('分页发现：cursor 循环直到没有 nextCursor，全部注册', async () => {
    const tools = createToolRegistry()
    const { client, listCalls } = fakeClient([
      page([{ name: 'a' }], 'page-2'),
      page([{ name: 'b' }]),
    ])
    await syncTools(client, tools, 'fs', new Map())
    expect(listCalls).toEqual([{ cursor: undefined }, { cursor: 'page-2' }])
    expect(tools.list().map((d) => d.name).sort()).toEqual(['mcp__fs__a', 'mcp__fs__b'])
  })

  it('服务器重复列出同一工具名 = 无效工具列表：抛错且注册表零变化', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([page([{ name: 'dup' }, { name: 'dup' }])])
    await expect(syncTools(client, tools, 'srv', new Map())).rejects.toThrow(/无效工具列表/)
    expect(tools.list()).toEqual([])
  })

  it('两个 raw 名规范化后碰撞 = 无效工具列表：抛错', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([page([{ name: 'a.b' }, { name: 'a_b' }])])
    await expect(syncTools(client, tools, 'srv', new Map())).rejects.toThrow(/无效工具列表/)
    expect(tools.list()).toEqual([])
  })

  it('fetch 失败保留旧代：上一代注册原样可用', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([page([{ name: 'old' }])])
    const oldGeneration = await syncTools(client, tools, 'srv', new Map())
    expect(tools.get('mcp__srv__old')).toBeDefined()

    const failing = fakeClient([new Error('网络断了'), new Error('网络断了')])
    await expect(syncTools(failing.client, tools, 'srv', oldGeneration)).rejects.toThrow('网络断了')
    // 旧代仍在注册表且 disposers 仍有效
    expect(tools.get('mcp__srv__old')).toBeDefined()
    oldGeneration.get('mcp__srv__old')!()
    expect(tools.get('mcp__srv__old')).toBeUndefined()
  })

  it('register 冲突回滚整代：外部抢占命名空间时该 server 零工具', async () => {
    const tools = createToolRegistry()
    // 外部注册先占 mcp__srv__taken
    tools.register({
      declaration: { name: 'mcp__srv__taken', description: '外部抢占', parameters: { type: 'object' } },
      execute: async () => undefined,
    })
    const { client } = fakeClient([page([{ name: 'taken' }, { name: 'other' }])])
    await expect(syncTools(client, tools, 'srv', new Map())).rejects.toThrow(/工具已注册/)
    // 回滚：other 也没留下；squatter 原样
    expect(tools.get('mcp__srv__taken')?.declaration.description).toBe('外部抢占')
    expect(tools.get('mcp__srv__other')).toBeUndefined()
  })

  it('重同步成功换代：旧代工具消失、新代出现（同名工具重建）', async () => {
    const tools = createToolRegistry()
    const genA = fakeClient([page([{ name: 'a' }])])
    const first = await syncTools(genA.client, tools, 'srv', new Map())

    const genB = fakeClient([page([{ name: 'a' }, { name: 'b' }])])
    const second = await syncTools(genB.client, tools, 'srv', first)

    expect(tools.list().map((d) => d.name).sort()).toEqual(['mcp__srv__a', 'mcp__srv__b'])
    // 旧代 disposer 已失效（幂等撤销：dispose 旧代的 map 不会再删新代注册）
    expect(second.get('mcp__srv__a')).toBeDefined()
  })

  it('fetch 阶段不 dispose 旧代（swap 才换）：失败路径旧代 disposer 不被调用', async () => {
    const tools = createToolRegistry()
    const { client } = fakeClient([page([{ name: 'old' }])])
    const oldGeneration: ToolDisposers = await syncTools(client, tools, 'srv', new Map())
    const oldDisposer = oldGeneration.get('mcp__srv__old')!
    const spy = vi.fn(oldDisposer)

    const failing = fakeClient([new Error('列表拉取失败'), new Error('列表拉取失败')])
    await expect(syncTools(failing.client, tools, 'srv', oldGeneration)).rejects.toThrow()

    expect(spy).not.toHaveBeenCalled()
    expect(tools.get('mcp__srv__old')).toBeDefined()
  })
})
