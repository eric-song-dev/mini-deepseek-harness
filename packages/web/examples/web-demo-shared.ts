import { Context } from 'cordis'
import { fileURLToPath } from 'node:url'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { openAiLlm, provideLlm } from '@mini-dsh/llm'
import type { OpenAiLlmOptions } from '@mini-dsh/llm'
import { bashTool, toolRegistry } from '@mini-dsh/tools'
import { forkProvider, spawnProvider, SubagentRuntime, toolSubagent } from '@mini-dsh/subagent'
import { toolWorkflow, WorkflowEngine } from '@mini-dsh/workflow'
import { mcpClient } from '@mini-dsh/mcp'
import { deepseekWebSearch, fakeWebSearch, webRuntime, webSearchTool } from '@mini-dsh/web-search'
import { createFakeLlm } from '@mini-dsh/test-support'
import { datedSystemPrompt } from '@mini-dsh/agent'
import { webHost } from '@mini-dsh/web'
import type { RpcBridge, WebHostHandle } from '@mini-dsh/web'

/**
 * web demo 的共享 runtime（post-MVP 增补）：demo:web（真 OpenAI 兼容 adapter）与
 * demo:web:fake（假 LLM 台词本）**只有一行区别**——`llm: 'fake' | 'real'`。
 * 这正是 LLM seam 的教学点：换 provider = 换提供 `llm` 服务的插件，host、loop、
 * 流式、轨迹一行不改。测试（tests/web-demo.test.ts）用真 adapter 指向本地
 * 假 HTTP 端点跑全链路，零 key 零外网。
 *
 * M8 起同时挂 subagent/workflow（host 侧插件，client 零改动）：`subagent`/`workflow`
 * 就是 tools seam 里的普通工具，浏览器里的 tool 卡片、轨迹面板、会话列表都是现成
 * UI——子会话经会话列表点选回放。fake 台词本第一轮就是一段委派场景（父派子 agent
 * 跑 bash date → 子回答 → 父汇报），零 key 在浏览器里可见多智能体全程。
 *
 * M9 起同时挂 mcp-client（fixture server）：外部 MCP server 的工具（mcp__fixture__*）
 * 与本地工具同形态出现在浏览器 tool 卡片——能力接入零 client 改动；配置不在 Web
 * （MCP 配置 UI 是裁剪项）。fake 台词本第二轮调 mcp__fixture__add（真协议真子进程）。
 *
 * M10 起同时挂 web search 三层（能力 seam + 提供方 + 工具）：fake 模式挂
 * fakeWebSearch（零 key，台词本第三轮调 web_search），real 模式挂
 * deepseekWebSearch（读 DEEPSEEK_API_KEY，无 key 时 available()=false——工具仍在、
 * 模型若调用会得到可读 {error} 结果：稳定注册在浏览器可见）。同一个 web_search
 * 工具，换提供方只换一行——LLM seam 之外第二个"换 provider 不改消费方"的示范。
 */

/** 与 web demo 同仓的玩具 MCP server（真 stdio 协议，零 key）。 */
export const FIXTURE_SERVER_URL = new URL('../../mcp/examples/fixture-server.mjs', import.meta.url)

export type WebDemoLlmMode = 'fake' | 'real'

export interface WebDemoRuntimeOptions {
  /** 会话目录。 */
  sessionsDir: string
  /** HTTP 监听端口；0 = 随机（测试）。 */
  port: number
  /** 静态文件目录（浏览器页面）；缺省不服务静态文件。 */
  staticDir?: string
  /** 注入桥（测试/内嵌）；缺省自建。 */
  bridge?: RpcBridge
  /** LLM 模式：fake = 台词本（零 key 教学演示）；real = OpenAI 兼容 adapter。 */
  llm: WebDemoLlmMode
  /** real 模式的 API key（fake 模式忽略）。 */
  apiKey?: string
  /** real 模式的 base URL（默认 api.deepseek.com；Ollama/vLLM 等兼容端点）。 */
  baseUrl?: string
  /** real 模式的模型名（默认 deepseek-chat）。 */
  model?: string
}

export interface WebDemoRuntime {
  ctx: Context
  handle: WebHostHandle
  /** 关停：先显式关 webHost（含会话 flush 落盘），再卸载插件作用域。 */
  stop: () => Promise<void>
}

/** 假 LLM 台词本（demo:web:fake 用）：第一轮 = subagent 委派场景，其后 5 轮 bash 工具往返 + 流式台词。 */
export function fakeWebDemoReplies(): Parameters<typeof createFakeLlm>[0]['replies'] {
  // 第一轮：父 agent 调 subagent 工具派生子 agent（子 agent 再跑一次 bash date），
  // 回收结果后父流式汇报——多智能体委派在浏览器里可见（tool 卡片 + 会话列表出现子会话）。
  const delegationCall = {
    toolCalls: [{
      id: 'd1',
      name: 'subagent',
      arguments: { description: '问时间', prompt: '用 bash 执行 date，然后把结果念出来' },
    }],
  }
  const childToolCall = {
    toolCalls: [{ id: 'd2', name: 'bash', arguments: { command: "date '+%F %T %Z'" } }],
  }
  const childAnswer = {
    chunks: ['bash 已经跑完了，', '工具结果我看过了。', '（我是子 agent，我的中间过程父 agent 看不到）'],
    chunkDelay: 45,
  }
  const parentAnswer = {
    chunks: ['子 agent 已经', '替我跑完了 date，', '它把时间汇报给了我。'],
    chunkDelay: 45,
  }
  // 第二轮：调外部 MCP server 的工具（真 stdio 协议 + 真子进程）——
  // 浏览器 tool 卡片上出现 mcp__fixture__add，与本地工具同形态。
  const mcpAddCall = {
    toolCalls: [{ id: 'm1', name: 'mcp__fixture__add', arguments: { a: 2, b: 3 } }],
  }
  const mcpAnswer = {
    chunks: ['刚才那个工具卡片', '是外部 MCP server 的 add：', '我调了它，2 + 3 = 5。'],
    chunkDelay: 45,
  }
  // 第三轮：调 web_search（零 key：fakeWebSearch 假提供方）——
  // 浏览器 tool 卡片上出现 web_search，结果与轨迹面板里的结构化 sources 同源。
  const webSearchCall = {
    toolCalls: [{ id: 's1', name: 'web_search', arguments: { query: '事件溯源 event sourcing' } }],
  }
  const webSearchAnswer = {
    chunks: ['刚才那个工具卡片是', 'web_search：搜索由', 'fakeWebSearch 假提供方返回。'],
    chunkDelay: 45,
  }
  const bashCall = {
    toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo 你好，我是工具卡片' } }],
  }
  const streamReply = {
    chunks: ['你好！', '我是迷你', ' DeepSeek Harness 的', '演示助手。', '（这段话是流式分片渲染的）'],
    chunkDelay: 45,
  }
  return [delegationCall, childToolCall, childAnswer, parentAnswer, mcpAddCall, mcpAnswer,
    webSearchCall, webSearchAnswer,
    ...Array.from({ length: 5 }, () => [bashCall, streamReply]).flat()]
}

/** 组装 web demo runtime：JSONL 后端 + SessionManager + bash 工具 + LLM（fake/real）+ webHost。 */
export async function createWebDemoRuntime(options: WebDemoRuntimeOptions): Promise<WebDemoRuntime> {
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: options.sessionsDir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)
  // M8：多智能体编排（host 侧插件，client 零改动）。subagent/workflow 是 tools seam
  // 里的普通工具：tool 卡片、轨迹面板、会话列表都是现成 UI，子会话独立落盘可回放。
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawnProvider)
  await ctx.plugin(forkProvider)
  await ctx.plugin(toolSubagent)
  await ctx.plugin(WorkflowEngine)
  await ctx.plugin(toolWorkflow)
  // M9：外部工具协议——一行插件 + 一段配置 = 接入一个 stdio MCP server。其工具
  // （mcp__fixture__*）与 bash/subagent 同形态进 tools 注册表，浏览器零改动。
  await ctx.plugin(mcpClient, {
    serverName: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(FIXTURE_SERVER_URL)],
  })
  // M10：web search 三层——seam 与工具常挂；提供方按 LLM 模式换（见下方分支）。
  // 能力 seam + 消费方工具是稳定注册：提供方缺失/无 key 时工具仍在。
  await ctx.plugin(webRuntime)
  await ctx.plugin(webSearchTool)

  // LLM seam 的两种 provider：换一行 = 假变真（其余插件零改动）
  if (options.llm === 'real') {
    const openAiOptions: OpenAiLlmOptions = {}
    if (options.apiKey !== undefined) openAiOptions.apiKey = options.apiKey
    if (options.baseUrl !== undefined) openAiOptions.baseUrl = options.baseUrl
    if (options.model !== undefined) openAiOptions.model = options.model
    await ctx.plugin(openAiLlm, openAiOptions)
    // 真提供方（读 DEEPSEEK_API_KEY）：无 key 时 available()=false，模型若调
    // web_search 会得到可读 {error} 结果——稳定注册在浏览器可见；有 key 即真搜索。
    await ctx.plugin(deepseekWebSearch)
  } else {
    await ctx.plugin(provideLlm, createFakeLlm({ replies: fakeWebDemoReplies() }))
    // 假提供方：台词本第三轮的 web_search 由它回答，零 key 全链路可回放。
    await ctx.plugin(fakeWebSearch)
  }

  // 系统提示注入当前时间（post-MVP）：模型不知道"今天几号"的确定性兜底。
  // fake 模式的基础提示是台词本剧本，real 模式是普通助手提示（不强制工具往返）。
  const basePrompt = options.llm === 'real'
    ? '你是 mini-deepseek-harness 的演示助手，回答简洁；有需要时可以用工具。'
    : '你是 mini-deepseek-harness 的演示助手：先调一次工具，再流式给出最终回答。'
  // 注入桥（测试）才传 bridge：不传时 webHost 自建 WS 升级路径（浏览器连接的通道）。
  // 传了 bridge 就等于声明"桥由外部管理"，webHost 跳过 WS——两条路径二选一。
  const webOptions: {
    port: number
    staticDir?: string
    bridge?: RpcBridge
    systemPrompt: string
    stream: true
  } = {
    port: options.port,
    systemPrompt: datedSystemPrompt(basePrompt),
    stream: true,
  }
  if (options.staticDir !== undefined) webOptions.staticDir = options.staticDir
  if (options.bridge !== undefined) webOptions.bridge = options.bridge

  const fiber = await ctx.plugin(webHost, webOptions)
  const handle = fiber.ctx['web-host']
  return {
    ctx,
    handle,
    stop: async () => {
      await handle.close()
      await ctx.fiber.dispose()
    },
  }
}
