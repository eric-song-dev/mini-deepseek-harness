import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { toolRegistry } from '@mini-dsh/tools'
import { mcpClient } from '../src/index'

/**
 * 【M9 教程练习 2：把你的 MCP server 接进 mini】（零 key）
 *
 * mcp-client 连上练习 1 的骰子 server（真 stdio 协议 + 真子进程），断言：
 *   1. 工具以公开名 mcp__mydice__random_dice 出现在注册表；
 *   2. execute 返回掷骰结果文本。
 *
 * 红绿翻转（小白验收）：把 examples/my-dice-server.mjs 里工具名 random_dice
 * 改成 dice，运行本测试看红（发现不到工具），再改回来变绿。
 *
 * 运行：pnpm vitest run packages/mcp/tests/my-dice.test.ts
 * 教程：docs/tutorials/M9-mcp.md
 */

const diceServerPath = fileURLToPath(new URL('../examples/my-dice-server.mjs', import.meta.url))

describe('M9 教程练习：我的骰子 MCP server', () => {
  it('mcp-client 连上它：工具以公开名出现且可执行', async () => {
    const ctx = new Context()
    await ctx.plugin(toolRegistry)
    await ctx.plugin(mcpClient, {
      serverName: 'mydice',
      transport: 'stdio',
      command: process.execPath,
      args: [diceServerPath],
    })
    try {
      // 1. 发现：公开名 = mcp__<serverName>__<rawName>；raw 名绝不注册
      const tool = ctx.tools.get('mcp__mydice__random_dice')
      expect(tool).toBeDefined()
      expect(tool!.declaration.description).toContain('骰子')
      expect(ctx.tools.get('random_dice')).toBeUndefined()

      // 2. 执行：参数经 wire 往返，结果是掷骰文本
      const output = await ctx.tools.execute('mcp__mydice__random_dice', { sides: 6 }, { cwd: process.cwd() })
      expect(output).toMatchObject({ content: expect.stringMatching(/🎲 掷出了 [1-6]（6 面骰）/) })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
