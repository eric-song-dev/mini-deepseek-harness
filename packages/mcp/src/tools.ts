import type { Tool, ToolsService } from '@mini-dsh/tools'
import { MAX_PUBLIC_NAME_LENGTH } from './config'

/**
 * MCP 工具桥（tools.ts）：发现外部 server 的工具、以确定性公开名注册进
 * Tools 注册表、执行时把公开名翻译回 rawName 走 wire。
 *
 * 命名契约（上游 mcp-client note "Naming invariants" 的 mini 版）：
 * 每个 MCP 工具有一个稳定标识 (serverName, rawName)；rawName 只用于协议
 * （tools/call），公开名绝不发给服务器、绝不解析还原。公开名是
 * (serverName, rawName) 的纯函数：连接顺序、重新同步、其他 server 都
 * 不会重命名既有工具。
 */

/** wire 上的非法字符（DeepSeek 函数名约定只允许 [A-Za-z0-9_-]）。 */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/**
 * 推导一个 MCP 工具的模型可见公开名。
 *
 * 干净情况 = `mcp__<serverName>__<rawName>` 原样；非法字符替换为 `_`；
 * 超长（>64）**报错**——mini 裁剪：不做上游的截断 + hash 后缀分支。
 * 安全论证：mini 注册表重名必抛、两阶段同步的 swap 冲突整代回滚，
 * 规范化碰撞绝不静默损坏工具，只可能响亮地少一组工具（M9 spec 决策 1）。
 *
 * @param serverName 已通过 config 校验的本地命名空间（^[A-Za-z0-9_-]{1,32}$）。
 * @param rawName MCP server 自己声明的工具名（不可信输入，可能带 `.` 等非法字符）。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized.length > MAX_PUBLIC_NAME_LENGTH) {
    throw new Error(
      `MCP 工具公开名超过 ${MAX_PUBLIC_NAME_LENGTH} 字符：mcp__${serverName}__${rawName}（mini 不做截断+hash 规范化）`,
    )
  }
  return normalized
}

// ---- 窄接口：工具桥只依赖这两个方法，单测用可编程假 client，真实现是 SDK Client ----

/** MCP 服务器声明的单个工具（wire 上能拿到的最小形状）。 */
export interface McpToolInfo {
  name: string
  /** exactOptionalPropertyTypes：SDK 声明了显式 undefined 联合，这里照收。 */
  description?: string | undefined
  inputSchema?: Record<string, unknown> | undefined
}

/** tools/list 的一页结果。 */
export interface McpListToolsResult {
  tools: McpToolInfo[]
  /** exactOptionalPropertyTypes：SDK 声明了显式 undefined 联合，这里照收。 */
  nextCursor?: string | undefined
}

/** 单个 MCP 内容块（信任边界：字段可能缺失，都按可选读；exactOptionalPropertyTypes 照收 SDK 的 undefined 联合）。 */
export interface McpContentBlock {
  type: string
  text?: string | undefined
  mimeType?: string | undefined
  /** image 块携带的 base64 数据（bridge 不消费，只声明形状）。 */
  data?: string | undefined
}

/** tools/call 的结果（SDK 可能返回 legacy toolResult 形状，见 executor）。 */
export interface McpCallToolResult {
  content?: McpContentBlock[] | undefined
  isError?: boolean | undefined
  /** SDK 兼容形状（legacy server 返回 toolResult 而非 content）。 */
  toolResult?: unknown
}

/**
 * 工具桥对 MCP client 的窄接口：只声明 bridge 用到的两个能力。
 * @modelcontextprotocol/sdk 的 Client 天然满足；测试注入假实现。
 */
export interface McpClientLike {
  listTools(params: { cursor?: string }): Promise<McpListToolsResult>
  /** SDK 的 arguments 可选（协议允许省略）；bridge 总是显式传递。 */
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult>
}

/** 一代工具注册的撤销函数表：公开名 → 撤销（幂等）。 */
export type ToolDisposers = Map<string, () => void>

/** 无效工具列表（同一公开名出现两次：重复列名或规范化碰撞）。 */
export class InvalidToolListError extends Error {
  constructor(serverName: string, rawName: string) {
    super(`MCP server "${serverName}" 无效工具列表：工具 "${rawName}" 与其他工具坍缩为同一公开名`)
    this.name = 'InvalidToolListError'
  }
}

/**
 * 两阶段同步：把 MCP server 的当前工具列表注册进 Tools 注册表。
 *
 * 1. fetch：分页 listTools（cursor 循环）攒齐新一代定义。任何失败（网络错误、
 *    无效工具列表、公开名超长）直接 reject——**不碰注册表**，旧代原样。
 * 2. swap：先 dispose 旧代全部撤销函数，再逐个注册新代。register 冲突（只可能
 *    是外部注册抢占了 mcp__<serverName>__ 命名空间）→ 回滚本次已注册的新代
 *    （该 server 零工具）再抛错——模型要么看到完整一代、要么一代都看不到。
 *
 * @param client 已连接的 MCP client（窄接口）。
 * @param tools mini 的 Tools 注册表。
 * @param serverName 本地命名空间（已过 config 校验）。
 * @param previous 上一代的撤销函数表（初始同步传空 Map）。
 * @returns 新代的撤销函数表——本 server 名下"存活注册"的完整集合。
 */
export async function syncTools(
  client: McpClientLike,
  tools: ToolsService,
  serverName: string,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // Phase 1：fetch——攒新一代，不碰注册表。
  const definitions = new Map<string, Tool>()
  let cursor: string | undefined
  do {
    const response = await client.listTools(cursor === undefined ? {} : { cursor })
    for (const tool of response.tools) {
      const publicName = publicToolName(serverName, tool.name)
      if (definitions.has(publicName)) throw new InvalidToolListError(serverName, tool.name)
      definitions.set(publicName, {
        declaration: {
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
        // 执行闭包（T5）：rawName 只走 wire，公开名绝不外发。
        execute: createExecutor(client, tool.name),
      })
    }
    cursor = response.nextCursor
  } while (cursor !== undefined)

  // Phase 2：swap——换代。
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, tools.register(definition))
    }
  } catch (error) {
    for (const dispose of disposers.values()) dispose()
    throw error
  }
  return disposers
}

/**
 * 为一个 MCP 工具造 execute 闭包：持有 (client, rawName)，把模型参数
 * `tools/call` 到服务器，再把 MCP 内容块映射成 mini 工具输出。
 *
 * 语义（M9 spec 决策 3）：
 * - rawName 只走 wire——公开名绝不发给服务器、绝不解析还原；
 * - isError:true 是**结果**不是异常：返回 { isError: true, content } 让模型
 *   看到失败原因自行纠正（与 bash 的 exit code、skill 的 { error } 同款纪律）；
 * - 仅 transport 级失败（未连接等）throw——走 loop 的 turn/end(crash) 路径；
 * - input 非对象（模型给了裸 JSON 值）兜底 {}，让服务器给出具体缺参错误。
 */
function createExecutor(
  client: McpClientLike,
  rawName: string,
): (input: Record<string, unknown>) => Promise<unknown> {
  return async (input) => {
    const args = typeof input === 'object' && input !== null ? input : {}
    const result = await client.callTool({ name: rawName, arguments: args })

    // legacy 形状（SDK 兼容面）：没有 content 数组时按无输出处理。
    if (!Array.isArray(result.content)) {
      if (result.isError === true) return { isError: true, content: '(no output)' }
      return { content: '(no output)' }
    }

    const text = extractText(result.content, rawName)
    if (result.isError === true) return { isError: true, content: text }
    return { content: text }
  }
}

/**
 * 把 MCP 内容块数组投影成单段文本：text 块以 '\n' 连接（上游教训：无分隔符
 * join 会吞掉块间边界），image/audio/resource/未知块变占位符（上游同款文案）。
 * 信任边界：字段按可选读——内容来自外部进程，声明必填的字段也可能缺失。
 */
function extractText(content: McpContentBlock[], rawName: string): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${String(block.type)}]`)
    }
  }
  return parts.join('\n') || `(${rawName} returned no text content)`
}
