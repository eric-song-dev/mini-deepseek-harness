import 'cordis'
import type {
  SubagentProvider,
  SubagentRunEndInfo,
  SubagentRunInfo,
} from './types'

export { SubagentError, SubagentRuntime } from './service'
export type { SubagentsService, Unregister } from './service'
export type {
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentStartRequest,
  SubagentStopReason,
} from './types'

// subagent/* 事件词汇（M8）：模块增强写进类型系统，emit 未声明事件名是编译错误
// （同 session/events.ts 的 M1 模式）。start/end 只观察不落父日志（Session 桥接
// 只收 SESSION_EVENT_NAMES）；provider-added/removed 是服务 ctx 上的注册表事件。
declare module 'cordis' {
  interface Events {
    /** 一个 provider 进入注册表。 */
    'subagent/provider-added'(provider: SubagentProvider): void
    /** 一个 provider 离开注册表；已接受的 run 仍归持有方。 */
    'subagent/provider-removed'(name: string): void
    /** 一个已发布的子 agent 就绪（与 `subagent/end` 按 runId 配对；emit 在父会话 ctx）。 */
    'subagent/start'(info: SubagentRunInfo): void
    /** 一个已发布的子 agent 停稳（终态结局；emit 在父会话 ctx）。 */
    'subagent/end'(info: SubagentRunEndInfo): void
  }
}
