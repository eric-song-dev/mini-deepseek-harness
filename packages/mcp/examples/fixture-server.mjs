// 教学玩具 MCP server（stdio transport）：M9 的 demo 与 e2e 共用的真协议 server。
//
// 教学要点：MCP server 只是一个说 JSON-RPC 的程序——语言无关、构建无关。
// 这个文件是纯 JS，`node fixture-server.mjs` 直跑，不需要任何构建步骤；
// mcp-client 插件用 StdioClientTransport 拉起它（command: 'node', args: [本文件]）。
//
// 工具集合刻意覆盖桥接的各个路径：
//   add / greet      正常工具（参数往返）
//   fail             isError:true —— 模型可见的失败结果
//   image            多内容块 + 非文本块（占位符投影）
//   admin.reset      带点号的名字（公开名规范化）
//   crash            回复后退出进程（断开即撤销的演示扳机）

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.registerTool('add', {
  title: 'Add Tool',
  description: '把两个数加起来。',
  inputSchema: {
    a: z.number().describe('第一个数'),
    b: z.number().describe('第二个数'),
  },
}, async (args) => ({
  content: [{ type: 'text', text: String(args.a + args.b) }],
}))

server.registerTool('greet', {
  title: 'Greet Tool',
  description: '按名字打招呼。',
  inputSchema: { name: z.string().describe('要打招呼的名字') },
}, async (args) => ({
  content: [{ type: 'text', text: `Hello, ${args.name}!` }],
}))

server.registerTool('fail', {
  title: 'Fail Tool',
  description: '永远返回一个错误（isError）。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'Something went wrong' }],
  isError: true,
}))

server.registerTool('image', {
  title: 'Image Tool',
  description: '返回一个带图片内容块的回复。',
  inputSchema: {},
}, async () => ({
  content: [
    { type: 'text', text: 'Here is an image:' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'text', text: 'End of image.' },
  ],
}))

// 回复之后才退出（25ms），让调用方先拿到干净的结果、随后收到连接断开。
server.registerTool('crash', {
  title: 'Crash Tool',
  description: '回复后退出 server 进程（断开即撤销演示）。',
  inputSchema: {},
}, async () => {
  setTimeout(() => process.exit(7), 25)
  return { content: [{ type: 'text', text: 'crashing' }] }
})

// MCP 允许带点号的名字；mini 的公开名规范化为下划线。
server.registerTool('admin.reset', {
  title: 'Admin Reset Tool',
  description: '名字带点号的工具（公开名规范化演示）。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'reset done' }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
