import type { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveConfig } from './config'
import type { McpConfig } from './config'
import { syncTools } from './tools'
import type { ToolDisposers } from './tools'

export { publicToolName, syncTools, InvalidToolListError } from './tools'
export type { McpClientLike, McpToolInfo, McpListToolsResult, McpContentBlock, McpCallToolResult, ToolDisposers } from './tools'
export { ConfigError, resolveConfig, SERVER_NAME_PATTERN, MAX_PUBLIC_NAME_LENGTH } from './config'
export type { McpConfig } from './config'

/**
 * MCP client 桥接插件：连接一个外部 MCP server，把它的工具以
 * `mcp__<serverName>__<rawName>` 公开名注册进现有 Tools 注册表。
 * 一个插件实例 = 一个 MCP server；N 个 server = profile 里 N 行同插件
 * 不同 config（上游同款 namespace 插件形态，不造独立服务键）。
 *
 * 生命周期（M9 spec 决策 4）：
 * - 启动：校验配置 → 预留 serverName → spawn 子进程连接 → 初始同步
 *   （失败恒 throw = 插件启动失败，fail-fast）→ 工具注册完毕才激活；
 * - 断开即撤销：stdio 子进程退出触发 onclose → 该 server 全部工具注销
 *   （mini 语义：不保留死工具；重连 = dispose 后重新装载，公开名是纯
 *   函数所以重建出的名字完全相同）；
 * - list_changed 通知 → 重同步（fetch 失败保留旧代）；
 * - dispose：注销全部工具 + 关连接（杀子进程）+ 释放 serverName
 *   （M6 注册可逆纪律；cordis 会 await effect 清理的 Promise）。
 */

/** 插件名（loader 诊断用）。 */
export const name = 'mcp-client'

/** 唯一依赖：现有 Tools 注册表。 */
export const inject = ['tools']

/** 客户端握手时的自身标识（wire 上可见，不冒充上游）。 */
const CLIENT_INFO = { name: 'mini-deepseek-harness', version: '0.1.0' }

/** 存活 serverName 预留表：按 ctx.root 键控（并存 app 互不可见），ctx.effect 挂载/释放。 */
const activeServerNames = new WeakMap<Context, Set<string>>()

export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  // 配置校验先于一切：非法配置在构造任何连接前响亮报错。
  const config = resolveConfig(rawConfig)

  // 预留命名空间：重复 serverName 是配置错误，后加载实例启动失败、前实例无损。
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) {
      names = new Set()
      activeServerNames.set(ctx.root, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" 已被另一个 mcp-client 实例占用——换一个唯一的 serverName`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  })

  const client = new Client(CLIENT_INFO)
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // mini 裁剪：不做上游的凭据 scrub（清 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_*），
    // 直接进程环境 + 显式 env 覆盖——教程注明取舍。
    env: childEnv(config.env),
    cwd: config.cwd,
  })

  let disposers: ToolDisposers = new Map()

  try {
    await client.connect(transport)
  } catch (error) {
    // 连接失败：close 触发 SDK 侧清理（spawn 失败时无子进程可杀，幂等）。
    await safeClose(client)
    throw error
  }

  // 断开即撤销：子进程退出 → 该 server 的工具全部消失（幂等，日志可见）。
  client.onclose = () => {
    if (disposers.size === 0) return
    ctx.logger.warn('mcp-client(%s): 连接断开，撤销 %d 个工具注册', config.serverName, disposers.size)
    for (const off of disposers.values()) off()
    disposers = new Map()
  }

  // 子进程非零退出时 SDK 会额外给一个 onerror（McpError "Connection closed"）——
  // 不接住会变成未处理异常。断开语义已由 onclose 承担，这里只记日志。
  client.onerror = (error) => {
    ctx.logger.warn('mcp-client(%s): 连接错误：%s', config.serverName, String(error))
  }

  // list_changed → 重同步：两阶段同步保证失败时旧代原样（fetch 失败不碰注册表）。
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    void (async () => {
      try {
        disposers = await syncTools(client, ctx.tools, config.serverName, disposers)
      } catch (error) {
        ctx.logger.error('mcp-client(%s): 重新同步失败，保留旧代：%s', config.serverName, String(error))
      }
    })()
  })

  // 初始同步：失败 = 插件启动失败（fail-fast 二态已裁剪——mini 恒 throw）。
  try {
    disposers = await syncTools(client, ctx.tools, config.serverName, disposers)
  } catch (error) {
    await safeClose(client)
    throw error
  }

  // 注册可逆（M6）：dispose = 注销全部工具 + 关连接（杀子进程）。
  ctx.effect(() => () => {
    for (const off of disposers.values()) off()
    disposers = new Map()
    return safeClose(client)
  })
}

/** 幂等关闭：SDK close 对未连接/已关闭的 client 也安全。 */
async function safeClose(client: { close(): Promise<void> }): Promise<void> {
  try {
    await client.close()
  } catch {
    // dispose 路径不允许二次抛错掩盖真正的卸载原因。
  }
}

/**
 * 子进程环境：进程环境（滤掉 undefined 值）+ 显式配置的 env 覆盖。
 * 上游在此处做凭据 scrub（清 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_*），
 * mini 裁剪为直传——教程注明取舍。
 */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value
  }
  return { ...base, ...extra }
}

/** 直接 `ctx.plugin(mcpClient, config)` 的便捷入口（inject 随函数走，M3 同款模式）。 */
export const mcpClient = Object.assign(apply, { inject })
// 函数的 name 属性只读，Object.assign 撞键会抛——defineProperty 覆盖。
Object.defineProperty(mcpClient, 'name', { value: name, configurable: true })
