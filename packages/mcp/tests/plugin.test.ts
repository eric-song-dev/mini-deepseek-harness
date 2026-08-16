import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { toolRegistry } from '@mini-dsh/tools'
import { apply } from '../src/index'

/**
 * 插件生命周期契约（T6）：SDK 三个模块被 vi.mock 成可编程假实现——
 * connect 成功 → 初始同步 → 工具注册；初始失败恒 throw（fail-fast）且
 * 关闭连接不泄漏子进程；重复 serverName 后加载失败前实例无损；onclose
 * 断开即撤销；list_changed 重同步（成功换代/失败保留旧代）；dispose
 * 撤销 + 关连接 + 释放命名空间（HMR-safety：卸载后重装恢复）。
 */

const sdk = vi.hoisted(() => {
  const clients: FakeClient[] = []
  const clientOptions: unknown[] = []
  const transportOptions: unknown[] = []
  /** 下一个实例的预设故障（在实例创建前注入）。 */
  const pending: { connectError?: string; listError?: string } = {}
  return { clients, clientOptions, transportOptions, pending }
})

/** 可编程假 MCP client：覆盖插件用到的全部协议方法。 */
interface FakeClient {
  connectResult: Promise<void>
  listPages: Array<unknown | Error>
  callToolResult: unknown
  closeCalls: number
  onclose: (() => void) | undefined
  listChangedHandler: (() => void) | undefined
  connect(): Promise<void>
  listTools(): Promise<unknown>
  callTool(): Promise<unknown>
  setNotificationHandler(schema: unknown, handler: () => void): void
  close(): Promise<void>
}

function page(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>, nextCursor?: string): unknown {
  return { tools, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

function makeFake(): FakeClient {
  const fake: FakeClient = {
    connectResult: sdk.pending.connectError === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(sdk.pending.connectError)),
    listPages: sdk.pending.listError === undefined
      ? [page([{ name: 'add', description: '加两个数' }, { name: 'greet' }])]
      : [new Error(sdk.pending.listError)],
    callToolResult: { content: [{ type: 'text', text: 'ok' }] },
    closeCalls: 0,
    onclose: undefined,
    listChangedHandler: undefined,
    connect: async () => { await fake.connectResult },
    listTools: async () => {
      const next = fake.listPages.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('假 client 台词耗尽')
      return next
    },
    callTool: async () => fake.callToolResult,
    setNotificationHandler: (_schema, handler) => { fake.listChangedHandler = handler },
    close: async () => { fake.closeCalls++ },
  }
  return fake
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function (this: unknown, options: unknown) {
    sdk.clientOptions.push(options)
    const fake = makeFake()
    sdk.clients.push(fake)
    return fake // 构造器返回对象时 new 表达式的值就是这个对象
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function (this: unknown, options: unknown) {
    sdk.transportOptions.push(options)
    return { kind: 'stdio-transport' }
  }),
}))

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ToolListChangedNotificationSchema: { __mcpSchema: 'ToolListChangedNotification' },
}))

function lastClient(): FakeClient {
  return sdk.clients[sdk.clients.length - 1]!
}

/** 在 ctx 上装 tools 服务 + 一个 mcp-client 实例。 */
async function mount(rawConfig: unknown, ctx: Context) {
  await ctx.plugin(toolRegistry)
  const fiber = await ctx.plugin(apply, rawConfig)
  return { ctx, fiber }
}

const CONFIG = {
  serverName: 'fixture',
  transport: 'stdio',
  command: 'node',
  args: ['server.mjs'],
  env: { EXTRA: 'yes' },
  cwd: '/tmp/work',
} as const

beforeEach(() => {
  sdk.clients.length = 0
  sdk.clientOptions.length = 0
  sdk.transportOptions.length = 0
  delete sdk.pending.connectError
  delete sdk.pending.listError
})

describe('mcp-client 插件生命周期', () => {
  it('启动即连接 + 初始同步：工具在插件激活前注册完毕，客户端以 name/version 标识', async () => {
    const { ctx } = await mount(CONFIG, new Context())
    const names = ctx.tools.list().map((d) => d.name).sort()
    expect(names).toEqual(['mcp__fixture__add', 'mcp__fixture__greet'])
    expect(sdk.clientOptions[0]).toMatchObject({ name: 'mini-deepseek-harness', version: expect.any(String) })
    expect(sdk.transportOptions[0]).toMatchObject({
      command: 'node',
      args: ['server.mjs'],
      env: { EXTRA: 'yes' },
      cwd: '/tmp/work',
    })
    // env 覆盖在进程环境之上（mini 不做凭据 scrub——裁剪决定）
    expect((sdk.transportOptions[0] as { env: Record<string, string> }).env.PATH).toBe(process.env.PATH)
  })

  it('connect 失败 = 插件启动失败：apply reject 且连接被关闭（子进程不泄漏）', async () => {
    sdk.pending.connectError = 'spawn ENOENT'
    await expect(mount(CONFIG, new Context())).rejects.toThrow('spawn ENOENT')
    expect(lastClient().closeCalls).toBe(1)
  })

  it('初始同步失败 = 插件启动失败：apply reject、零工具、连接关闭', async () => {
    sdk.pending.listError = 'tools/list 超时'
    const ctx = new Context()
    await ctx.plugin(toolRegistry)
    await expect(ctx.plugin(apply, CONFIG)).rejects.toThrow('tools/list 超时')
    expect(ctx.tools.list()).toEqual([])
    expect(lastClient().closeCalls).toBe(1)
  })

  it('配置非法：Client 从未被构造（校验先于任何连接）', async () => {
    await expect(mount({ serverName: 'fs', transport: 'http', command: 'x' }, new Context())).rejects.toThrow(/只支持 stdio/)
    expect(sdk.clients).toHaveLength(0)
  })

  it('重复 serverName：后加载实例启动失败，前实例工具无损', async () => {
    const { ctx } = await mount(CONFIG, new Context())
    const before = ctx.tools.list().length

    await expect(ctx.plugin(apply, CONFIG)).rejects.toThrow(/serverName "fixture" 已被/)
    expect(ctx.tools.list()).toHaveLength(before)
    expect(sdk.clients).toHaveLength(1) // 第二个实例从未连接
  })

  it('onclose 断开即撤销：该 server 的全部工具消失，重复触发幂等', async () => {
    const { ctx } = await mount(CONFIG, new Context())
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()

    lastClient().onclose!()
    expect(ctx.tools.list()).toEqual([])

    // 幂等：再次触发不报错、不误删任何东西
    expect(() => lastClient().onclose!()).not.toThrow()
    expect(ctx.tools.list()).toEqual([])
  })

  it('list_changed 重同步成功：新代替换旧代（旧工具消失、新工具出现）', async () => {
    const { ctx } = await mount(CONFIG, new Context())
    lastClient().listPages = [page([{ name: 'greet' }, { name: 'echo', description: '回声' }])]
    lastClient().listChangedHandler!()
    await vi.waitFor(() => {
      const names = ctx.tools.list().map((d) => d.name).sort()
      expect(names).toEqual(['mcp__fixture__echo', 'mcp__fixture__greet'])
    })
  })

  it('list_changed 重同步失败：保留旧代，注册表不变', async () => {
    const { ctx } = await mount(CONFIG, new Context())
    lastClient().listPages = [new Error('拉取失败')]
    lastClient().listChangedHandler!()
    // 给异步重同步一个落定的机会，然后断言旧代原样
    await new Promise((resolve) => setTimeout(resolve, 20))
    const names = ctx.tools.list().map((d) => d.name).sort()
    expect(names).toEqual(['mcp__fixture__add', 'mcp__fixture__greet'])
  })

  it('dispose：关连接 + 撤销全部工具 + 释放 serverName（随后可重装）', async () => {
    const { ctx, fiber } = await mount(CONFIG, new Context())
    await fiber.dispose()
    expect(ctx.tools.list()).toEqual([])
    expect(lastClient().closeCalls).toBe(1)

    // 命名空间已释放：同 ctx 可再次装载同 serverName
    const second = await ctx.plugin(apply, CONFIG)
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()
    await second.dispose()
  })

  it('HMR-safety：卸载即撤销、重装即恢复（M6 注册可逆纪律）', async () => {
    const { ctx, fiber } = await mount(CONFIG, new Context())
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get('mcp__fixture__add')).toBeUndefined()

    await ctx.plugin(apply, CONFIG)
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()
  })

  it('初始同步失败后重装可用（上次失败不残留任何状态）', async () => {
    sdk.pending.listError = '首次失败'
    const ctx = new Context()
    await ctx.plugin(toolRegistry)
    await expect(ctx.plugin(apply, CONFIG)).rejects.toThrow('首次失败')

    delete sdk.pending.listError
    await ctx.plugin(apply, CONFIG)
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()
  })
})
