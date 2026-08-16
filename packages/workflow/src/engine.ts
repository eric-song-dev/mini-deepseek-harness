import { randomUUID } from 'node:crypto'
import { Context, Service } from 'cordis'
import type { SubagentRun } from '@mini-dsh/subagent'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowResultInfo,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
  WorkflowStopReason,
} from './types'

/**
 * WorkflowEngine seam（M8）：同线程执行模型编写的编排脚本，脚本每次 `agent()` =
 * 一次 `ctx.subagents.start()`——workflow 是 subagents 之上的**消费方**（上游
 * "同一引擎 + subagents 可承载专用编排策略而不改 agent loop"的分层）。
 *
 * 关键语义（照搬上游 workflow 子系统）：
 * - meta/args 是纯 JSON 数据：meta shape 校验、脚本 parse 都发生在**任何 agent
 *   启动之前**（同步失败，不发布 run）；
 * - 失败纪律：钩子误用抛 `fatal: true` 的 {@link WorkflowError}；`parallel()` /
 *   `pipeline()` 对 fatal **直接 re-throw**（拼错选项必须终止脚本），逐项 `null`
 *   只留给子 run 失败与阶段内普通脚本错误；
 * - `result` 从不 reject：脚本失败 → `stopReason: 'error'`；已接受的取消覆盖
 *   后到的非取消结果；
 * - 同线程 `async Function`：**不是沙箱**（无 fs/网络/timer 注入只是可移植性 API
 *   设计，不是隔离）；cancel 只能在钩子 await 点生效，同步死循环无法打断
 *   （上游 worker-thread 隔离是解决路径，mini 不照搬——M8 spec 决策 6）；
 * - 事件 emit 在父会话 ctx（隔离总线 → 不落父日志），`workflow/end` 刻意不含
 *   value；监听器异常被隔离（记日志、不传播、不阻断脚本）。
 */

/** 机器可路由的 fatal 失败码（mini 子集）。 */
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'AGENT_START'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED'

/**
 * 类型化的 workflow seam 错误。`fatal` 驱动组合器纪律：parallel/pipeline 对 fatal
 * 直接 re-throw（误用必须杀脚本），逐项 null 只留给普通错误与子失败。
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode
  readonly fatal: boolean

  constructor(message: string, code: WorkflowErrorCode, options: { fatal?: boolean } = {}) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.fatal = options.fatal ?? true
  }
}

/** 组合器是否必须 re-throw 该错误（fatal 纪律的判定点）。 */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}

/** 引擎插件配置。 */
export interface WorkflowEngineConfig {
  /** `agent()` 使用的 subagent provider 名（默认 `spawn`）。 */
  provider?: string
}

/** `workflow/*` 事件名全集（emit 容器的分发面）。 */
export type WorkflowEventName =
  | 'workflow/start'
  | 'workflow/phase'
  | 'workflow/log'
  | 'workflow/agent-start'
  | 'workflow/agent-end'
  | 'workflow/end'

/** AsyncFunction 构造器（ESM 下无全局 AsyncFunction）。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...args: unknown[]) => Promise<unknown>

/** 渲染任意抛出的值（连 String 强制都可能抛）。 */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** meta shape 校验：坏数据在脚本 parse 之前响亮拒绝（fail-closed）。 */
function validateMeta(meta: unknown): WorkflowMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new WorkflowError('meta 必须是对象（纯 JSON 数据）', 'META_INVALID')
  }
  const record = meta as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') {
    throw new WorkflowError('meta.name 必须是非空字符串', 'META_INVALID')
  }
  if (typeof record.description !== 'string' || record.description === '') {
    throw new WorkflowError('meta.description 必须是非空字符串', 'META_INVALID')
  }
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') {
    throw new WorkflowError('meta.whenToUse 必须是字符串', 'META_INVALID')
  }
  let phases: WorkflowPhase[] | undefined
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      throw new WorkflowError('meta.phases 必须是数组', 'META_INVALID')
    }
    phases = record.phases.map((phase) => {
      if (typeof phase !== 'object' || phase === null
        || typeof (phase as Record<string, unknown>).title !== 'string'
        || (phase as Record<string, unknown>).title === '') {
        throw new WorkflowError('meta.phases[].title 必须是非空字符串', 'META_INVALID')
      }
      return phase as WorkflowPhase
    })
  }
  return {
    name: record.name,
    description: record.description,
    ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
    ...(phases === undefined ? {} : { phases }),
  }
}

/** 脚本 parse 先行：坏脚本在任何 agent 启动前失败（构造 AsyncFunction 即解析）。 */
function parseScript(script: unknown): (...args: unknown[]) => Promise<unknown> {
  if (typeof script !== 'string' || script === '') {
    throw new WorkflowError('script 必须是非空字符串', 'INVALID_ARGUMENT')
  }
  try {
    return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', script)
  } catch (error) {
    throw new WorkflowError(`workflow 脚本无法解析：${renderThrown(error)}`, 'SCRIPT_PARSE')
  }
}

/** agent() 的允许选项（mini 子集：schema/provider/model 砍掉，未知选项响亮拒绝）。 */
const AGENT_OPTION_KEYS = ['label', 'phase'] as const

/** 校验 agent() 的 opts：未知键 → UNSUPPORTED_OPTION（fatal），坏类型 → INVALID_ARGUMENT。 */
function normalizeAgentOptions(opts: unknown): { label?: string; phase?: string } {
  if (opts === undefined) return {}
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new WorkflowError('agent() 的 opts 必须是对象', 'INVALID_ARGUMENT')
  }
  const record = opts as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(AGENT_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new WorkflowError(`agent() 不支持的选项：${key}`, 'UNSUPPORTED_OPTION')
    }
  }
  if (record.label !== undefined && typeof record.label !== 'string') {
    throw new WorkflowError('agent() 的 label 必须是字符串', 'INVALID_ARGUMENT')
  }
  if (record.phase !== undefined && typeof record.phase !== 'string') {
    throw new WorkflowError('agent() 的 phase 必须是字符串', 'INVALID_ARGUMENT')
  }
  return {
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.phase === undefined ? {} : { phase: record.phase }),
  }
}

/** 无 label 时的展示兜底：prompt 前 20 字符（上游"a prompt snippet"同款）。 */
function promptSnippet(prompt: string): string {
  return prompt.length > 20 ? `${prompt.slice(0, 20)}…` : prompt
}

/** 离开脚本的值必须是纯 host JSON 数据（上游 materializeFromRealm 的 mini 版）。 */
function assertSerializable(value: unknown): void {
  if (typeof value === 'function') {
    throw new WorkflowError('workflow 脚本返回值必须是纯 JSON 数据（不允许函数）', 'RESULT_UNSERIALIZABLE')
  }
  try {
    if (JSON.stringify(value) === undefined) throw new TypeError('undefinable value')
  } catch {
    throw new WorkflowError('workflow 脚本返回值必须是纯 JSON 数据（不可序列化）', 'RESULT_UNSERIALIZABLE')
  }
}

/**
 * WorkflowEngine 实现：cordis Service（inject `['subagents']`），同线程执行。
 */
export class WorkflowEngine extends Service {
  static inject = ['subagents']

  private readonly provider: string

  constructor(ctx: Context, config: WorkflowEngineConfig = {}) {
    super(ctx, 'workflowEngine')
    this.provider = config.provider ?? 'spawn'
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    // meta 校验 + 脚本 parse 先行：任何失败都同步抛出、不发布 run、不 emit 事件。
    const meta = validateMeta(request.meta)
    const fn = parseScript(request.script)
    const id = randomUUID()
    const info: WorkflowRunInfo = { id, meta }

    // 取消状态：cancel() 与外部 signal 汇入同一个 flag（首个原因胜出）。
    let cancelled = false
    let cancelReason: string | undefined
    const controller = new AbortController()
    const acceptCancel = (reason: unknown): void => {
      if (cancelled) return
      cancelled = true
      cancelReason = typeof reason === 'string' && reason !== '' ? reason : 'workflow run was cancelled'
    }
    const onAbort = (): void => { acceptCancel(request.signal?.reason) }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    // 事件容器化：emit 在父会话 ctx（隔离总线）；监听器异常记录日志、不传播。
    const emit = (name: WorkflowEventName, ...args: unknown[]): void => {
      try {
        ;(request.parent.emit as (event: string, ...payload: unknown[]) => void)(name, ...args)
      } catch (error) {
        this.ctx.logger.warn(`workflow: ${name} 监听器抛错：${renderThrown(error)}`)
      }
    }

    const throwIfCancelled = (): void => {
      if (cancelled) throw new WorkflowError(cancelReason ?? 'workflow run was cancelled', 'CANCELLED')
    }

    // ---- 脚本钩子（script realm 只注入这五个 + args）----
    let nextSeq = 0
    let agentsStarted = 0

    const agent = async (prompt: unknown, opts?: unknown): Promise<unknown> => {
      throwIfCancelled()
      if (typeof prompt !== 'string' || prompt === '') {
        throw new WorkflowError('agent() 需要非空 prompt 字符串', 'INVALID_ARGUMENT')
      }
      const options = normalizeAgentOptions(opts)
      nextSeq++
      agentsStarted++
      const seq = nextSeq
      const label = options.label ?? promptSnippet(prompt)

      let run: SubagentRun
      try {
        run = await this.ctx.subagents.start(this.provider, {
          prompt,
          parent: request.parent,
          signal: controller.signal,
          ...(options.label === undefined ? {} : { label: options.label }),
        })
      } catch (error) {
        if (isFatalWorkflowError(error)) throw error
        // seam 启动失败是机器路由的 fatal：脚本必须终止，而不是消融成 null。
        throw new WorkflowError(`agent() 无法启动子 agent：${renderThrown(error)}`, 'AGENT_START')
      }

      const agentInfo: WorkflowAgentInfo = {
        seq,
        label,
        ...(options.phase === undefined ? {} : { phase: options.phase }),
        childId: run.id,
      }
      emit('workflow/agent-start', info, agentInfo)

      let result: Awaited<SubagentRun['result']>
      try {
        result = await run.result
      } finally {
        await run.dispose()
      }
      if (cancelled) {
        emit('workflow/agent-end', info, { ...agentInfo, outcome: 'cancelled' } satisfies WorkflowAgentEndInfo)
        throwIfCancelled()
      }
      const completed = result.stopReason === 'completed'
      emit('workflow/agent-end', info, { ...agentInfo, outcome: completed ? 'completed' : 'failed' } satisfies WorkflowAgentEndInfo)
      return completed ? result.output : null
    }

    const parallel = async (thunks: unknown): Promise<unknown> => {
      throwIfCancelled()
      if (!Array.isArray(thunks)) {
        throw new WorkflowError('parallel() 需要 thunk 数组', 'INVALID_ARGUMENT')
      }
      return Promise.all(thunks.map(async (thunk) => {
        if (typeof thunk !== 'function') {
          throw new WorkflowError('parallel() 的元素必须是零参函数', 'INVALID_ARGUMENT')
        }
        try {
          return await thunk()
        } catch (error) {
          // fatal 纪律：拼错选项/超限必须杀脚本；普通脚本错误 → 该元素 null。
          if (isFatalWorkflowError(error)) throw error
          return null
        }
      }))
    }

    const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown> => {
      throwIfCancelled()
      if (!Array.isArray(items)) {
        throw new WorkflowError('pipeline() 需要 items 数组', 'INVALID_ARGUMENT')
      }
      if (stages.some((stage) => typeof stage !== 'function')) {
        throw new WorkflowError('pipeline() 的 stage 必须是函数', 'INVALID_ARGUMENT')
      }
      // item 独立推进：各 item 依次过完自己的阶段，item 之间无跨阶段屏障。
      return Promise.all(items.map(async (item, index) => {
        let prev: unknown
        for (const stage of stages) {
          try {
            prev = await (stage as (prev: unknown, item: unknown, index: number) => unknown)(prev, item, index)
          } catch (error) {
            if (isFatalWorkflowError(error)) throw error
            return null // 阶段内普通错误：该 item 结算为 null 并跳过剩余阶段
          }
        }
        return prev
      }))
    }

    const phase = (title: unknown): void => {
      if (typeof title !== 'string' || title === '') {
        throw new WorkflowError('phase() 需要非空标题字符串', 'INVALID_ARGUMENT')
      }
      emit('workflow/phase', info, title)
    }

    const log = (message: unknown): void => {
      if (typeof message !== 'string') {
        throw new WorkflowError('log() 需要字符串', 'INVALID_ARGUMENT')
      }
      emit('workflow/log', info, message)
    }

    // 发布 run：meta 已校验、脚本已 parse，body 即将执行。
    emit('workflow/start', info)

    const result: Promise<WorkflowResult> = (async () => {
      let value: unknown = null
      let stopReason: WorkflowStopReason = 'completed'
      let error: string | undefined
      try {
        const returned = await fn(request.args, agent, parallel, pipeline, phase, log)
        if (returned !== undefined) {
          value = returned
          assertSerializable(value)
        }
        if (cancelled) {
          // 已接受的外部取消覆盖后到的非取消结果（上游同款）。
          stopReason = 'cancelled'
          error = cancelReason
          value = null
        }
      } catch (caught) {
        if (cancelled || (caught instanceof WorkflowError && caught.code === 'CANCELLED')) {
          stopReason = 'cancelled'
          error = cancelReason ?? renderThrown(caught)
        } else {
          stopReason = 'error'
          // WorkflowError 的 code 进 error 文本：消费方/模型可据机器可路由码纠正。
          error = caught instanceof WorkflowError
            ? `${caught.code}: ${caught.message}`
            : renderThrown(caught)
        }
      } finally {
        request.signal?.removeEventListener('abort', onAbort)
      }
      const resultInfo: WorkflowResultInfo = {
        stopReason,
        ...(error === undefined ? {} : { error }),
        agentsStarted,
      }
      // workflow/end 刻意省略 result value（观察者不得拿调用方 result 的可变别名）。
      emit('workflow/end', info, resultInfo)
      return { value, stopReason, ...(error === undefined ? {} : { error }), agentsStarted }
    })()

    const cancel = (reason?: string): void => {
      acceptCancel(reason)
      controller.abort(cancelReason ?? 'workflow run was cancelled')
    }

    let disposePromise: Promise<void> | undefined
    return {
      id,
      meta,
      result,
      cancel,
      dispose() {
        // 幂等：取消（若未结算）并等待 result（从不 reject；同线程无法打断
        // 同步死循环——已知限制，见文件头注释）。
        disposePromise ??= (async () => {
          cancel()
          await result
        })()
        return disposePromise
      },
    }
  }
}

// 服务类型增强：插件可通过 `ctx.workflowEngine` / `ctx.get('workflowEngine')` 取到 seam。
declare module 'cordis' {
  interface Context {
    workflowEngine: WorkflowEngine
  }
}
