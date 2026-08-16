import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { toolRegistry } from '@mini-dsh/tools'
import { mcpClient } from '../src/index'

/**
 * e2e（T7）：真 MCP 协议 + 真 stdio 子进程，零 key 零外网。
 * ①仓库内 fixture server（控制边界场景）；②官方 @modelcontextprotocol/server-filesystem
 * （与真实生态 server 的互操作证明）。参照上游 tests/mcp-client.e2e.ts 的分层。
 */

const fixtureServerPath = fileURLToPath(new URL('../examples/fixture-server.mjs', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const filesystemBin = join(packageDir, 'node_modules', '.bin', 'mcp-server-filesystem')

const STDIO_CONFIG = {
  transport: 'stdio',
  command: process.execPath,
  args: [fixtureServerPath],
} as const

async function mount(config: unknown): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(toolRegistry)
  await ctx.plugin(mcpClient, config)
  return ctx
}

describe('fixture server —— 真 stdio 协议', () => {
  let ctx: Context

  beforeAll(async () => {
    ctx = await mount({ ...STDIO_CONFIG, serverName: 'fixture' })
  }, 30_000)

  afterAll(async () => {
    await ctx.fiber.dispose()
  }, 30_000)

  it('发现全部 fixture 工具：mcp__fixture__ 命名空间下，raw 名绝不注册', () => {
    const names = ctx.tools.list().map((d) => d.name)
    expect(names).toContain('mcp__fixture__add')
    expect(names).toContain('mcp__fixture__greet')
    expect(names).toContain('mcp__fixture__fail')
    expect(names).toContain('mcp__fixture__image')
    expect(names).not.toContain('add')
    expect(names).not.toContain('crash')
  })

  it('点号名规范化：admin.reset → mcp__fixture__admin_reset 且可执行', async () => {
    const publicName = 'mcp__fixture__admin_reset'
    expect(ctx.tools.get(publicName)).toBeDefined()
    const output = await ctx.tools.execute(publicName, {}, { cwd: process.cwd() })
    expect(output).toEqual({ content: 'reset done' })
  })

  it('add(2, 3) → "5"（参数经 wire 往返）', async () => {
    const output = await ctx.tools.execute('mcp__fixture__add', { a: 2, b: 3 }, { cwd: process.cwd() })
    expect(output).toEqual({ content: '5' })
  })

  it('greet("World") → "Hello, World!"', async () => {
    const output = await ctx.tools.execute('mcp__fixture__greet', { name: 'World' }, { cwd: process.cwd() })
    expect(output).toEqual({ content: 'Hello, World!' })
  })

  it('fail() → { isError: true }（结果是失败，不是异常）', async () => {
    const output = await ctx.tools.execute('mcp__fixture__fail', {}, { cwd: process.cwd() })
    expect(output).toMatchObject({ isError: true, content: 'Something went wrong' })
  })

  it('image() → 文本与占位符同框连接', async () => {
    const output = await ctx.tools.execute('mcp__fixture__image', {}, { cwd: process.cwd() })
    expect(output).toEqual({
      content: 'Here is an image:\n[image: image/png, content discarded]\nEnd of image.',
    })
  })

  it('crash：server 进程退出 → 断开即撤销全部工具', async () => {
    const crashed = await ctx.tools.execute('mcp__fixture__crash', {}, { cwd: process.cwd() })
    expect(crashed).toEqual({ content: 'crashing' })
    // 子进程退出触发 SDK onclose → 插件撤销该 server 全部注册（M9 语义）
    await vi.waitFor(() => {
      const names = ctx.tools.list().map((d) => d.name)
      expect(names.filter((n) => n.startsWith('mcp__fixture__'))).toEqual([])
    }, { timeout: 15_000, interval: 100 })
  })
})

describe('官方 server-filesystem —— 与真实生态 server 互操作', () => {
  let ctx: Context
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mini-dsh-mcp-fs-'))
    ctx = await mount({
      serverName: 'filesystem',
      transport: 'stdio',
      // .bin 里的 shim 是带 shebang 的脚本：直接作为 command 交给系统执行
      //（上游 e2e 同款做法；用 node 包一层反而会把 shell 脚本当 JS 解析）。
      command: filesystemBin,
      args: [tempDir],
    })
  }, 60_000)

  afterAll(async () => {
    await ctx.fiber.dispose()
    await rm(tempDir, { recursive: true, force: true })
  }, 30_000)

  it('发现 filesystem 工具（官方 server 的 schema 原样透传）', () => {
    const names = ctx.tools.list().map((d) => d.name)
    expect(names).toContain('mcp__filesystem__read_file')
    expect(names).toContain('mcp__filesystem__write_file')
    expect(names).toContain('mcp__filesystem__list_directory')
  })

  it('write_file + read_file 往返：磁盘副作用独立断言', async () => {
    const filePath = join(tempDir, 'hello.txt')
    const content = 'Hello from MCP e2e test!'

    const writeResult = await ctx.tools.execute(
      'mcp__filesystem__write_file', { path: filePath, content }, { cwd: process.cwd() },
    )
    expect(writeResult).toMatchObject({ content: expect.stringContaining('Successfully wrote') })

    const onDisk = await readFile(filePath, 'utf8')
    expect(onDisk).toBe(content)

    const readResult = await ctx.tools.execute(
      'mcp__filesystem__read_file', { path: filePath }, { cwd: process.cwd() },
    )
    expect(readResult).toMatchObject({ content: expect.stringContaining(content) })
  })

  it('list_directory 显示刚写入的文件', async () => {
    await writeFile(join(tempDir, 'listed.txt'), 'listed')
    const result = await ctx.tools.execute(
      'mcp__filesystem__list_directory', { path: tempDir }, { cwd: process.cwd() },
    )
    expect(result).toMatchObject({ content: expect.stringContaining('listed.txt') })
  })
})
