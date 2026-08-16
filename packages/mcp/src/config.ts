/**
 * MCP 插件配置（T2）：mini 没有 schemastery，手写 resolveConfig——
 * 非法配置在装载时响亮报错（消息含字段名），合法配置补默认值。
 *
 * 与上游 Config 的差异（裁剪，见 docs/milestones/M9.md 与上游调研 note）：
 * - 只做 stdio transport（校验拒绝其他值）；
 * - 拒绝未知字段（防 server_name 之类拼写错误被静默忽略；上游 schemastery
 *   默认 strip 未知键，mini 手写校验选择 fail-fast 教学语义）；
 * - 无 toolCallTimeoutMs / failOnStartupError / reconnect（均已裁剪）。
 */

/** serverName 的合法形状：工具公开名 mcp__<serverName>__<rawName> 的命名空间段。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 公开工具名的硬上限（DeepSeek 函数名约定，wire 协议常量而非配置）。 */
export const MAX_PUBLIC_NAME_LENGTH = 64

/**
 * 一个 stdio MCP server 的解析后配置。
 * 原始配置经 `resolveConfig` 校验后才有这个形状（缺省字段已补默认值）。
 */
export interface McpConfig {
  /** 本地稳定的命名空间；跨存活 mcp-client 实例唯一。 */
  serverName: string
  /** mini 只支持 stdio。 */
  transport: 'stdio'
  /** 拉起 server 子进程的命令（不经 shell，直接 spawn）。 */
  command: string
  /** 传给 command 的参数（默认 []）。 */
  args: string[]
  /** 覆盖在进程环境之上的额外环境变量（默认 {}；mini 不做凭据 scrub——裁剪）。 */
  env: Record<string, string>
  /** 子进程工作目录（默认 = resolveConfig 调用方的默认值）。 */
  cwd: string
}

/** 配置非法。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** 允许出现的字段（用于未知字段检查）。 */
const KNOWN_KEYS = new Set(['serverName', 'transport', 'command', 'args', 'env', 'cwd'])

/**
 * 校验并规范化原始配置（来自 profile.yml 插件行的 options）。
 * @param raw 原始配置（可能来自 yaml，类型未知）。
 * @param defaultCwd 缺省 cwd（调用方传 process.cwd()；测试传入固定值）。
 */
export function resolveConfig(raw: unknown, defaultCwd = process.cwd()): McpConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('MCP 插件配置必须是对象')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(`未知配置字段：${key}（合法字段：${[...KNOWN_KEYS].join(', ')}）`)
    }
  }
  const serverName = record.serverName
  if (typeof serverName !== 'string' || serverName.length === 0) {
    throw new ConfigError('serverName 必填：工具的模型可见名是 mcp__<serverName>__<tool>')
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new ConfigError(`serverName "${serverName}" 不合法：须匹配 ^[A-Za-z0-9_-]{1,32}$`)
  }
  const transport = record.transport
  if (transport !== 'stdio') {
    if (transport === undefined) {
      throw new ConfigError('transport 必填：mini 只支持 stdio（在配置里写 transport: "stdio"）')
    }
    throw new ConfigError(`transport "${String(transport)}" 不支持：mini 只支持 stdio（streamable-http 是裁剪项）`)
  }
  const command = record.command
  if (typeof command !== 'string' || command.length === 0) {
    throw new ConfigError('command 必填：拉起 MCP server 子进程的可执行文件（如 node / npx）')
  }
  const args = record.args
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    throw new ConfigError('args 必须是字符串数组（不经 shell 拼接，逐字传给 command）')
  }
  const env = record.env
  if (
    env !== undefined
    && (typeof env !== 'object' || env === null || Array.isArray(env)
      || Object.values(env).some((value) => typeof value !== 'string'))
  ) {
    throw new ConfigError('env 必须是 { 变量名: 字符串值 } 的对象')
  }
  const cwd = record.cwd
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new ConfigError('cwd 必须是字符串（子进程工作目录）')
  }
  return {
    serverName,
    transport: 'stdio',
    command,
    args: args === undefined ? [] : [...(args as string[])],
    env: env === undefined ? {} : { ...(env as Record<string, string>) },
    cwd: cwd === undefined ? defaultCwd : cwd,
  }
}
