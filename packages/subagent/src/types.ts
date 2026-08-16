import type { Context } from 'cordis'

/**
 * Subagents seam 的消费方面词汇（M8）：请求/结果/run/提供方类型 + `subagent/*` 事件载荷。
 * 照搬上游概念（packages/subagent/subagent/src/types.ts），mini 裁剪：
 * - `prompt` 是 string（mini 的 user 事件载荷就是 string，无 ContentBlock）；
 * - `parent` 是父会话 ctx（mini 无 Agent 服务，见 M8 spec 决策 2）；
 * - 无能力矩阵（outputSchema/depthLimit/toolFilter/persona 砍）与可继续路径。
 */

/** 单次 run 的结束原因。子级失败以非 completed 的 stopReason resolve（result 不 reject）。 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error'

/**
 * 一次单次委派的启动请求。provider 在 `start()` 兑现前拥有未发布资源（拒绝 =
 * 已清理干净）；兑现后轮次与基础设施故障归 run 所有。
 */
export interface SubagentStartRequest {
  /** 可选展示标签（子会话 title 的素材）。 */
  label?: string
  /** 交付给子 agent 的 user 消息正文。 */
  prompt: string
  /**
   * 委派方（父）的会话 ctx。provider 从它读谱系（`session-meta`：id/depth/cwd）、
   * 日志（`session-log`：fork 种子来源），并把 `subagent/*` 观察事件 emit 进
   * 父会话的隔离事件总线（不落父日志）。
   */
  parent: Context
  /**
   * 取消信号。启动前中止 → `start()` 拒绝；mini 的 loop 没有中途取消，
   * 发布后 signal 不再有语义（已知限制，见 M8 spec 决策 3）。
   */
  signal?: AbortSignal
}

/**
 * 单次 run 的终态产出。`result` 失败不 reject：子级失败以非 `completed` 的
 * `stopReason` resolve；只有无法表示的基础设施故障才 reject。非 completed
 * 意味着 `output` 可能不完整——消费方映射为 isError 工具结果，不把部分输出当成功。
 */
export interface SubagentResult {
  /** 子 agent 的最后一条非空 assistant 文本；没有产出时为空串。 */
  output: string
  /** 为什么结束。 */
  stopReason: SubagentStopReason
}

/**
 * 提供方返回的已发布 run 句柄：一次可 dispose 的前台委派，只有一个结果。
 * `id` == 子会话 id（本地 in-process run）；消费方 await result 后总是 dispose。
 */
export interface SubagentRun {
  /** run id（== 子会话 id）。 */
  readonly id: string
  /** 终态结果；不 reject（见 {@link SubagentResult}）。 */
  readonly result: Promise<SubagentResult>
  /** 幂等：等结果停稳、释放子会话资源。 */
  dispose(): Promise<void>
}

/**
 * 一个具名子 agent 传输实现（in-process）。多提供方可共存按名注册（上游 LLM
 * 适配器注册表模式，与 bash 的"每 ctx 单执行器"形成对照——教学点：多实现 seam）。
 */
export interface SubagentProvider {
  /** 唯一注册名（如 `spawn`、`fork`）。 */
  readonly name: string
  /**
   * 子 agent 是否看得到父已完成轮次（fork=true / spawn=false）。
   * 只描述对话种子注入，不暗示工具/服务/权限继承。
   */
  readonly inheritsParentContext: boolean
  /** 建立已发布的子 agent 并返回其 run 句柄；拒绝 = 未发布资源已清理。 */
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** `subagent/start` 载荷（与 `subagent/end` 按 runId 配对）。 */
export interface SubagentRunInfo {
  /** 与配对的 end 事件共享的唯一标识。 */
  runId: string
  /** 建子 agent 时登记的提供方名。 */
  provider: string
  /** 子会话 id。 */
  id: string
  /** mini 只有 in-process 提供方，恒 true。 */
  local: true
}

/** `subagent/end` 载荷：run 身份 + 终态。 */
export interface SubagentRunEndInfo extends SubagentRunInfo {
  /** 终态结束原因。 */
  stopReason: SubagentStopReason
  /** 子 agent 的最后 assistant 输出；基础设施拒绝或子没产出时为 undefined。 */
  lastAssistantMessage?: string
}
