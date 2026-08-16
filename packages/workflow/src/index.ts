import 'cordis'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from './types'

export { isFatalWorkflowError, WorkflowEngine, WorkflowError } from './engine'
export type { WorkflowEngineConfig, WorkflowErrorCode, WorkflowEventName } from './engine'
export type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowAgentOutcome,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowResultInfo,
  WorkflowRun,
  WorkflowRunInfo,
  WorkflowStartRequest,
  WorkflowStopReason,
} from './types'

// workflow/* 事件词汇（M8）：模块增强写进类型系统（M1 同款模式）。
// 全部 emit 在父会话 ctx（隔离总线）：只观察不落父日志；end 刻意不含 value。
declare module 'cordis' {
  interface Events {
    /** 一次 run 开始（meta 已校验、body 即将执行；与 workflow/end 配对）。 */
    'workflow/start'(info: WorkflowRunInfo): void
    /** 脚本进入一个阶段（纯进度分组，无执行语义）。 */
    'workflow/phase'(info: WorkflowRunInfo, title: string): void
    /** 脚本发出一行叙述（log(message)）。 */
    'workflow/log'(info: WorkflowRunInfo, message: string): void
    /** 一次 agent() 调用建立了已发布的子 run（与 workflow/agent-end 按 seq 配对）。 */
    'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
    /** 一次 agent() 调用结算（干净结果 / 子失败 / run 取消）。 */
    'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
    /** 一次 run 结算（任何 stop reason）；payload 刻意不含 result value。 */
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
  }
}
