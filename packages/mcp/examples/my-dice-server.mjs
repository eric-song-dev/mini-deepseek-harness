// 【M9 教程练习 1：写一个骰子 MCP server】（零 key）
//
// 照 fixture-server.mjs 的样子：一个工具 random_dice，入参 { sides }（面数，
// 默认 6），返回掷骰结果文本。纯 JS、零构建——`node my-dice-server.mjs` 直跑。
//
// 红绿翻转（小白验收）：把工具名 random_dice 改成 dice，运行
//   pnpm vitest run packages/mcp/tests/my-dice.test.ts
// 看红（测试发现不到 mcp__mydice__random_dice），再改回来变绿。
// 教程：docs/tutorials/M9-mcp.md

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'my-dice-server', version: '1.0.0' },
  { capabilities: { tools: {} } })

server.registerTool('random_dice', {
  title: 'Random Dice',
  description: '掷一个指定面数的骰子。',
  inputSchema: { sides: z.number().int().min(2).describe('面数').default(6) },
}, async (args) => {
  const sides = args.sides ?? 6
  const n = 1 + Math.floor(Math.random() * sides)
  return { content: [{ type: 'text', text: `🎲 掷出了 ${n}（${sides} 面骰）` }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
