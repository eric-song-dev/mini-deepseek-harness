import type { AssistantEventPayload, ToolCallPayload, ToolEventPayload, SessionEvent } from './events'

export interface RepairResult {
  /** 修复后的完整日志（没有断尾时就是原数组引用）。 */
  events: SessionEvent[]
  /** 补写出的全部事件（按日志顺序：先合成工具结果、再 turn/end）；无需修复时为空数组。 */
  repaired: SessionEvent[]
}

/** 合成结果的统一文案：模型据此识别"调用失败但可纠正"。 */
const INTERRUPTED_RESULT = { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' } as const

/**
 * 崩溃恢复的纯函数核心：日志里若有**未配对的 turn/start**（它后面没有对应的 turn/end），
 * 说明进程在"一轮对话中"被杀掉 —— 补一条 turn/end（reason: 'crash'）让这轮闭合。
 *
 * 判断方式：最后一条 turn/start 出现在最后一条 turn/end 之后（或根本没有 turn/end）。
 * 崩溃现场最常见的形态是 turn/start 之后跟着 user/tool 就戛然而止 —— 所以不是只看
 * "末尾是不是 turn/start"，而是看配对是否完整。MVP 假设单轮串行，最多一个未闭合的 turn。
 *
 * 在途工具调用（M3 起）：若崩溃发生在"assistant 声明 toolCalls"之后、结果落盘之前，
 * 只补 turn/end 会让 resume 后的模型输入以悬空 tool_calls 结尾而被 provider 拒绝
 * （上游 repair 同款处理：为每个 pending call 合成错误 tool 结果）。这里用与
 * projectMessages 相同的顺序配对，把没有结果的调用全部合成 isError 结果，
 * 补在 turn/end 之前——形状与 loop 的工具错误结果同构（{ isError: true, content }）。
 *
 * 幂等性来自修复动作本身：补写的事件会被持久化，下一次 load 时配对已完整，不会再补。
 * 补写事件的 ts 取最后一条日志的 ts（保持时间线单调，不把"修复时刻"算进轮耗时）。
 */
export function repairDanglingTurn(events: readonly SessionEvent[]): RepairResult {
  let lastTurnStart = -1
  let lastTurnEnd = -1
  for (let i = 0; i < events.length; i++) {
    const type = events[i]!.type
    if (type === 'turn/start') lastTurnStart = i
    else if (type === 'turn/end') lastTurnEnd = i
  }
  if (lastTurnStart <= lastTurnEnd) {
    return { events: events as SessionEvent[], repaired: [] }
  }

  // 在途工具调用：从最后一条 turn/start 起走与 projectMessages 相同的顺序配对。
  // assistant(带 toolCalls) 重置待配对队列；tool 结果事件消费队首。走完后队列里
  // 剩的就是"声明过但结果没回来"的调用（含从未开始执行的那些）。
  const pending: ToolCallPayload[] = []
  for (let i = lastTurnStart; i < events.length; i++) {
    const event = events[i]!
    if (event.type === 'assistant') {
      const toolCalls = (event.payload as AssistantEventPayload).toolCalls
      if (toolCalls !== undefined && toolCalls.length > 0) {
        pending.splice(0, pending.length, ...toolCalls)
      }
    } else if (event.type === 'tool') {
      const payload = event.payload as ToolEventPayload
      if (payload.output !== undefined) pending.shift()
    }
  }

  const last = events.at(-1)!
  const baseTs = last.ts
  let nextSeq = last.seq + 1
  const repaired: SessionEvent[] = []
  for (const call of pending) {
    repaired.push({
      seq: nextSeq++,
      type: 'tool',
      ts: baseTs,
      payload: { name: call.name, input: call.arguments, output: { ...INTERRUPTED_RESULT } },
    })
  }
  repaired.push({ seq: nextSeq++, type: 'turn/end', ts: baseTs, payload: { reason: 'crash' } })
  return { events: [...events, ...repaired], repaired }
}
