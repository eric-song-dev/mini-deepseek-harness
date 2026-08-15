import 'cordis'
import type { Context } from 'cordis'

/**
 * Tools seam：loop 之外的能力从哪来。
 *
 * 教学要点：这是本项目的第三个 seam（继 SessionPersistence、LLM 之后）。工具 =
 * 声明（name/description/参数 schema）+ 实现（execute），agent loop 只认注册表，
 * 不关心工具是 bash、文件还是将来的 MCP 服务（requirements §8）。
 *
 * 执行管线分三步：pre-execute（**approval hook 预留位**，M3 MVP 无 hook = 直接放行）
 * → execute（工具实现）→ post-execute（结果整形）。未来审批栈挂在 pre-execute，
 * MCP 工具换注册表实现，都不改 loop、不改管线。
 */

/** 工具声明：模型可读的"我能干什么"（与 llm 包 ToolSpec 结构相同）。 */
export interface ToolDeclaration {
  name: string
  description: string
  /** 参数 JSON Schema（OpenAI 兼容 function 协议原生格式）。 */
  parameters: Record<string, unknown>
}

/** 执行上下文：本次调用所处的环境信息。 */
export interface ToolContext {
  /** 会话工作目录；相对路径按它解析（M3 spec 决策 7：cwd 随会话 meta 走）。 */
  cwd: string
}

/** 一个工具 = 声明（给模型看）+ 实现（真正动手）。 */
export interface Tool {
  declaration: ToolDeclaration
  execute(input: Record<string, unknown>, ctx: ToolContext): unknown | Promise<unknown>
}

/** 一次工具调用的完整信息（管线各阶段的公共入参）。 */
export interface ToolInvocation {
  name: string
  input: Record<string, unknown>
  ctx: ToolContext
}

export type ToolHookPhase = 'pre-execute' | 'post-execute'

/**
 * 管线 hook：
 * - pre-execute：收到 invocation，拒绝时抛 ToolDeniedError（未来审批栈的挂点）；
 * - post-execute：收到 (invocation, output)，返回值替换输出（结果整形），
 *   返回 undefined 表示不改。
 */
export type ToolHook = (invocation: ToolInvocation, output?: unknown) => unknown | Promise<unknown>

/** Tools 抽象服务。 */
export interface ToolsService {
  /** 注册工具；重名报错（防止静默覆盖）。 */
  register(tool: Tool): void
  /** 按名查找工具；不存在返回 undefined。 */
  get(name: string): Tool | undefined
  /** 全部工具的声明（按注册顺序；loop 把它传给模型）。 */
  list(): ToolDeclaration[]
  /** 挂管线 hook（按阶段分组，同阶段按注册顺序执行）。 */
  addHook(phase: ToolHookPhase, hook: ToolHook): void
  /** 走完整管线执行一次工具调用。 */
  execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

/** 调用了未注册的工具。 */
export class UnknownToolError extends Error {
  readonly tool: string

  constructor(name: string) {
    super(`未知工具：${name}`)
    this.name = 'UnknownToolError'
    this.tool = name
  }
}

/** 工具被拒绝（pre-execute hook 抛出；M3 预留，未来审批栈使用）。 */
export class ToolDeniedError extends Error {
  readonly tool: string

  constructor(name: string, reason?: string) {
    super(reason === undefined ? `工具 ${name} 被拒绝` : `工具 ${name} 被拒绝：${reason}`)
    this.name = 'ToolDeniedError'
    this.tool = name
  }
}

/** 默认 Tools seam 实现：内存注册表 + 三段管线。 */
export function createToolRegistry(): ToolsService {
  const tools = new Map<string, Tool>()
  const hooks = new Map<ToolHookPhase, ToolHook[]>()

  const register: ToolsService['register'] = (tool) => {
    if (tools.has(tool.declaration.name)) {
      throw new Error(`工具已注册：${tool.declaration.name}`)
    }
    tools.set(tool.declaration.name, tool)
  }

  const get: ToolsService['get'] = (name) => tools.get(name)

  const list: ToolsService['list'] = () => [...tools.values()].map((tool) => tool.declaration)

  const addHook: ToolsService['addHook'] = (phase, hook) => {
    const phaseHooks = hooks.get(phase) ?? []
    phaseHooks.push(hook)
    hooks.set(phase, phaseHooks)
  }

  const execute: ToolsService['execute'] = async (name, input, ctx) => {
    const tool = tools.get(name)
    if (!tool) throw new UnknownToolError(name)
    const invocation: ToolInvocation = { name, input, ctx }
    // 第一步 pre-execute：approval 栈的预留位——MVP 没有 hook 时就是"直接放行"。
    for (const hook of hooks.get('pre-execute') ?? []) await hook(invocation)
    // 第二步 execute：工具实现本体；抛错原样传播（管线不吞错）。
    let output = await tool.execute(input, ctx)
    // 第三步 post-execute：结果整形；返回 undefined 表示不改。
    for (const hook of hooks.get('post-execute') ?? []) {
      const shaped = await hook(invocation, output)
      if (shaped !== undefined) output = shaped
    }
    return output
  }

  return { register, get, list, addHook, execute }
}

/** 工具注册表插件：把默认注册表注册成 `tools` 服务。 */
export function toolRegistry(ctx: Context): void {
  ctx.provide('tools', createToolRegistry())
}

/** 通用注入插件：把任意 ToolsService 实例注册成 `tools` 服务（测试/自定义注册表用）。 */
export function provideTools(ctx: Context, service: ToolsService): void {
  ctx.provide('tools', service)
}

// 服务类型增强：插件可通过 `ctx.tools` / `ctx.get('tools')` 取到 seam（M1 同款模式）。
declare module 'cordis' {
  interface Context {
    tools: ToolsService
  }
}
