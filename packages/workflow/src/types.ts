import type { Context } from 'cordis'

/**
 * Workflow seam 的词汇（M8）：请求/run/结果类型 + `workflow/*` 事件载荷。
 * 照搬上游概念（packages/workflow/workflow/src/types.ts + runtime-types.ts），mini 裁剪：
 * - 无 `subagentProvider` / `maxTotalAgents` 运行级策略（引擎配置里固定 provider）；
 * - `meta`/`args` 是纯 JSON 数据，引擎绝不通过对脚本文本求值获取它们。
 */

/** 脚本的身份块（meta 参数）：纯 JSON 数据。 */
export interface WorkflowMeta {
  /** 短 kebab-case 工作流名（展示 + 持久化键）。 */
  name: string
  /** 一行描述：这个工作流做什么。 */
  description: string
  /** 可选：何时适用（列表展示）。 */
  whenToUse?: string
  /** 可选阶段声明；`phase()` 调用按标题精确匹配（只做进度分组，无执行语义）。 */
  phases?: WorkflowPhase[]
}

/** meta.phases 里的一个阶段声明。 */
export interface WorkflowPhase {
  /** 阶段标题；`phase()` 按它匹配。 */
  title: string
  /** 可选一行描述。 */
  detail?: string
  /** 可选 provider 提示（informational）。 */
  provider?: string
  /** 可选 model 提示（informational）。 */
  model?: string
}

/** 一次 run 的结束原因（封闭联合，引擎所有，消费方可穷举）。 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/** 一次 run 的终态结果；`value` 仅在 completed 时有意义。 */
export interface WorkflowResult {
  /** 脚本的物化返回值（纯 host JSON 数据；无返回时为 null）。 */
  value: unknown
  /** 为什么结束。 */
  stopReason: WorkflowStopReason
  /** 失败消息（仅非 completed 时存在）。 */
  error?: string
  /** 整个生命周期里被接受的 agent() 调用数。 */
  agentsStarted: number
}

/** 调用方启动一次 workflow run 的请求。 */
export interface WorkflowStartRequest {
  /** 纯 JS 脚本体（顶层 await 允许；以 `return <json-value>` 结束）。 */
  script: string
  /** 身份块（纯 JSON 数据，引擎 shape 校验）。 */
  meta: WorkflowMeta
  /** 可选输入：逐字暴露给脚本的 `args` 全局。 */
  args?: unknown
  /**
   * 以谁的名义执行（每个 agent() 子代理都归属它）。emit 观察事件、读谱系/日志
   * 都走这个会话 ctx（M8 spec 决策 2/5）。
   */
  parent: Context
  /** 取消信号：中止即 cancel 本次 run。 */
  signal?: AbortSignal
}

/** 持有方拥有的活跃 run；result 从不 reject；cancel 只停在钩子 await 点。 */
export interface WorkflowRun {
  readonly id: string
  /** 已校验的 meta（脚本体运行前即可读）。 */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** 取消 run 与它的子 agent（记录首个原因）。 */
  cancel(reason?: string): void
  /** 幂等：必要时取消并等待有界结算与清理。 */
  dispose(): Promise<void>
}

/** 每个 `workflow/*` 事件 payload 的开头：run 身份快照（从不携带活跃 run）。 */
export interface WorkflowRunInfo {
  id: string
  meta: WorkflowMeta
}

/** 一次 agent() 调用的身份（workflow/agent-start 载荷）。 */
export interface WorkflowAgentInfo {
  /** 1 起、run 内递增的调用序号。 */
  seq: number
  /** 展示标签（label 选项，或 prompt 前 20 字符）。 */
  label: string
  /** 归属阶段（phase 选项）。 */
  phase?: string
  /** 子会话 id。 */
  childId: string
}

/** 一次 agent() 调用的结算方式。 */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** 一次 agent() 调用的结算（workflow/agent-end 载荷，与 agent-start 按 seq 配对）。 */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  outcome: WorkflowAgentOutcome
}

/**
 * 一次 run 结算的事件数据（workflow/end 载荷）：WorkflowResult 去掉 value——
 * 观察结果的监听器不得收到调用方 result 的可变别名（上游同款理由）。
 */
export interface WorkflowResultInfo {
  stopReason: WorkflowStopReason
  error?: string
  agentsStarted: number
}
