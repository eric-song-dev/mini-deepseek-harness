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
