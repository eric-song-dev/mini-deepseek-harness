import type { AssistantStreamPayload, SessionEvent, SessionEventType, TurnEndPayload, UserEventPayload } from './events'

/**
 * projectTurns（M5）：日志真源的"输出侧"投影 —— 把 append-only 日志按轮分组，
 * 输出轨迹视图（client 轨迹面板、未来的 CLI、测试）共用的一组结构。
 * 与 M2 的 projectMessages（输入侧，模型看什么）成对：同一份日志、两个消费者。
 */

/** 聚合的流式分片摘要（M5 spec 决策 3：一轮的分片合成一条摘要行，可展开看逐片与拼接全文）。 */
export interface ProjectedStreamSummary {
  /** 逐片内容（按到达顺序）。 */
  chunks: string[]
  /** 拼接全文（与随后 assistant 终事件的 content 一致）。 */
  joined: string
}

/** 轮内一条事件摘要（轨迹表的一个明细行）。 */
export interface ProjectedTurnEvent {
  /** 原始日志序号。 */
  seq: number
  /** 事件类型；分片聚合行的 type 为 'assistant/stream'。 */
  type: SessionEventType
  /** 事件时间戳（epoch 毫秒）；聚合行取首片 ts。 */
  ts: number
  /** 距上一条的耗时（毫秒）：轮内首条基准是 turn/start 的 ts；聚合行是末片 − 首片。 */
  durationMs: number
  /** 事件载荷；聚合行载荷为 ProjectedStreamSummary；旧日志无 usage 时原样保留（兜底显示 —）。 */
  payload: unknown
}

/** 一轮对话的投影（轨迹表的一行，点选展开事件明细）。 */
export interface ProjectedTurn {
  /** 轮序号（从 1 开始，按日志顺序）。 */
  index: number
  /** 本轮第一条用户消息；轮内没有 user 事件时为 null（异常日志）。 */
  userText: string | null
  /** turn/start 的时间戳。 */
  startedAt: number
  /** turn/end 的时间戳；断尾轮（M1 修复语义）取轮内最后事件的结束 ts。 */
  endedAt: number
  /** 整轮耗时（endedAt − startedAt，非负）。 */
  durationMs: number
  /** 轮结束方式；断尾轮按 M1 修复语义记为 'crash'。 */
  endReason: TurnEndPayload['reason']
  /** 轮内事件摘要（不含 turn/start 与 turn/end 本身；session/created 与轮外事件忽略）。 */
  events: ProjectedTurnEvent[]
}

/** 轮内事件类型：切块只认这些词汇事件。 */
const TURN_EVENT_TYPES = new Set<SessionEventType>(['user', 'assistant', 'assistant/stream', 'tool'])

/** 组装中的轮（内部可变结构，最终投影成 ProjectedTurn）。 */
interface MutableTurn {
  index: number
  userText: string | null
  startedAt: number
  events: ProjectedTurnEvent[]
}

function finalizeTurn(turn: MutableTurn, endedAt: number, endReason: TurnEndPayload['reason']): ProjectedTurn {
  return {
    index: turn.index,
    userText: turn.userText,
    startedAt: turn.startedAt,
    endedAt,
    durationMs: endedAt - turn.startedAt,
    endReason,
    events: turn.events,
  }
}

/**
 * 把日志投影成按轮分组的轨迹。切块规则：
 * - turn/start 开新轮（未闭合的旧轮按 M1 修复语义以 endReason 'crash' 闭合，endedAt 取轮内
 *   最后一条事件结束 ts —— 崩溃那一刻之后进程已死，确定性取"最后证据"的 ts）；
 * - turn/end 闭当前轮并透出 reason（done / limit / crash 是检查器要区分的三种收尾）；
 * - 其余词汇事件进当前轮；session/created 与轮外事件忽略；
 * - 连续 assistant/stream 分片聚合为一条摘要行（ts 取首片、durationMs 取末片−首片），
 *   后面的事件耗时从末片算起（整轮 durationMs 恒等于 endedAt − startedAt）。
 */
export function projectTurns(events: readonly SessionEvent[]): ProjectedTurn[] {
  const turns: ProjectedTurn[] = []
  let current: MutableTurn | null = null
  /** 上一条明细行的结束 ts（轮内首条之前的基准是 turn/start 的 ts）。 */
  let prevEnd = 0

  const closeCurrent = (endedAt: number, endReason: TurnEndPayload['reason']): void => {
    if (!current) return
    turns.push(finalizeTurn(current, endedAt, endReason))
    current = null
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      // 未闭合就开新轮：旧轮按 crash 闭合（结束 ts 取轮内最后一条事件的结束 ts）
      if (current) closeCurrent(prevEnd, 'crash')
      current = { index: turns.length + 1, userText: null, startedAt: event.ts, events: [] }
      prevEnd = event.ts
      continue
    }
    if (event.type === 'turn/end') {
      const payload = event.payload as TurnEndPayload
      closeCurrent(event.ts, payload.reason)
      continue
    }
    if (!current || !TURN_EVENT_TYPES.has(event.type)) continue

    if (event.type === 'assistant/stream') {
      // 分片聚合：相邻分片并入同一条摘要行（M5 spec 决策 3）
      const chunk = (event.payload as AssistantStreamPayload).content
      const last = current.events.at(-1)
      if (last && last.type === 'assistant/stream') {
        const summary = last.payload as ProjectedStreamSummary
        summary.chunks.push(chunk)
        summary.joined += chunk
        last.durationMs = event.ts - last.ts
        prevEnd = event.ts
        continue
      }
      current.events.push({
        seq: event.seq,
        type: event.type,
        ts: event.ts,
        durationMs: 0,
        payload: { chunks: [chunk], joined: chunk } satisfies ProjectedStreamSummary,
      })
      prevEnd = event.ts
      continue
    }

    const row: ProjectedTurnEvent = {
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      durationMs: event.ts - prevEnd,
      payload: event.payload,
    }
    if (event.type === 'user' && current.userText === null) {
      current.userText = (event.payload as UserEventPayload).content
    }
    current.events.push(row)
    // 单事件行的结束 ts 就是它自己的 ts（durationMs 是它距上一条的"空档"）
    prevEnd = event.ts
  }

  // 断尾：末尾未闭合的轮按 M1 修复语义投影成 crash（幂等——修复动作归 repairDanglingTurn，投影只读）
  if (current) closeCurrent(prevEnd, 'crash')
  return turns
}
