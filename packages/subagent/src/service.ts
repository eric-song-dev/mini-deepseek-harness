import { Context, Service } from 'cordis'
import type {
  SubagentProvider,
  SubagentRun,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentStartRequest,
} from './types'

/**
 * Subagents seam（M8）：具名 provider 注册表 + 一次前台 `start`。
 *
 * 教学要点：本项目的第五个 seam（继 SessionPersistence、LLM、Tools、Skills 之后）。
 * 与 bash 的"每 ctx 单执行器"不同，这里是**多实现注册表**（上游 LLM 适配器注册表
 * 模式）：多个提供方（spawn/fork）按名共存，调用方按名路由——换传输不改调用方。
 * 消费方（tool-subagent、workflowEngine）只认这套契约，agent loop 一行不感知。
 *
 * 生命周期契约（上游同款）：
 * - `start()` 兑现 = 子 agent 已发布（子会话已建好、loop 已装好）；拒绝 = 未发布
 *   资源已清理、**不 emit 生命周期事件对**；
 * - 发布后：`subagent/start` / `subagent/end` 按 runId 成对，emit 在**父会话 ctx**
 *   的隔离事件总线（Session 构造器给每会话独立 EventsService——mini 的
 *   scope-filtered 对应物；只观察不落父日志）；
 * - 移除 provider 阻止新 start，但**不撤销已返回给持有方的 run**。
 */

/** seam 层错误：机器可路由的 code（NO_PROVIDER / DUPLICATE_PROVIDER）。 */
export class SubagentError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'SubagentError'
    this.code = code
  }
}

/** 撤销函数：调用后撤销本次注册；幂等（重复调用无害）。 */
export type Unregister = () => void

/** Subagents 抽象服务。 */
export interface SubagentsService {
  /** 按名注册 provider；重名抛 DUPLICATE_PROVIDER。返回幂等撤销函数（M6 纪律）。 */
  registerProvider(provider: SubagentProvider): Unregister
  /** 按名查找；不存在返回 undefined。 */
  getProvider(name: string): SubagentProvider | undefined
  /** 已注册 provider 名（保持注册顺序）。 */
  list(): string[]
  /** 在具名 provider 上建立一次单次委派；返回已发布的 run。 */
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/** 默认实现：内存注册表 + 生命周期事件对（cordis Service，inject session-manager）。 */
export class SubagentRuntime extends Service implements SubagentsService {
  static inject = ['session-manager']

  private readonly providers = new Map<string, SubagentProvider>()

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  registerProvider(provider: SubagentProvider): Unregister {
    const name = provider.name
    if (this.providers.has(name)) {
      throw new SubagentError(`subagent provider "${name}" 已注册`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(name, provider)
    let active = true
    this.ctx.emit('subagent/provider-added', provider)
    return () => {
      // 幂等：只撤销"我注册的那一个"——若已被同名重注册，不误删新 provider
      if (active && this.providers.get(name) === provider) {
        this.providers.delete(name)
        this.ctx.emit('subagent/provider-removed', name)
      }
      active = false
    }
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  list(): string[] {
    return [...this.providers.keys()]
  }

  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`未注册 subagent provider：${name}`, 'NO_PROVIDER')
    }
    // 兑现 = 已发布。拒绝路径在 provider.start 内自行清理，这里不 emit 任何事件。
    const run = await provider.start(request)
    const info: SubagentRunInfo = { runId: run.id, provider: name, id: run.id, local: true }
    // 生命周期事件对：emit 在父会话 ctx（隔离总线 → 不落父日志、按父级作用域过滤）。
    // 监听器异常隔离（workflow 引擎同款纪律）：坏监听器抛错不能打断 start 兑现、
    // 不能饿死事件对——子 agent 已发布，调用方必须拿到 run 句柄才能回收。
    const emitStart = (payload: SubagentRunInfo): void => {
      try {
        request.parent.emit('subagent/start', payload)
      } catch (error) {
        this.ctx.logger.warn('subagent: subagent/start 监听器抛错：%s', renderThrown(error))
      }
    }
    const emitEnd = (payload: SubagentRunEndInfo): void => {
      try {
        request.parent.emit('subagent/end', payload)
      } catch (error) {
        this.ctx.logger.warn('subagent: subagent/end 监听器抛错：%s', renderThrown(error))
      }
    }
    // 先挂配对观察、再 emit start：result 无论何时结算，end 必成对（不留下孤儿 start）。
    const observed = run.result.then(
      (result) => {
        const end: SubagentRunEndInfo = {
          ...info,
          stopReason: result.stopReason,
          ...(result.output === '' ? {} : { lastAssistantMessage: result.output }),
        }
        emitEnd(end)
        return result
      },
      (error: unknown) => {
        // 基础设施故障（result 意外 reject）：事件对仍闭合，不留下孤儿 start。
        emitEnd({ ...info, stopReason: 'error' })
        throw error
      },
    )
    emitStart(info)
    return { ...run, result: observed }
  }
}

/** 渲染任意抛出的值（连 String 强制都可能抛）。 */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

// 服务类型增强：插件可通过 `ctx.subagents` / `ctx.get('subagents')` 取到 seam。
declare module 'cordis' {
  interface Context {
    subagents: SubagentsService
  }
}
