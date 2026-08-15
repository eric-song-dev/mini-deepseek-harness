import type { SessionEvent } from './events'

export interface RepairResult {
  /** 修复后的完整日志（没有断尾时就是原数组引用）。 */
  events: SessionEvent[]
  /** 补写出的 turn/end；无需修复时为 null。 */
  repaired: SessionEvent | null
}

/**
 * 崩溃恢复的纯函数核心：日志里若有**未配对的 turn/start**（它后面没有对应的 turn/end），
 * 说明进程在"一轮对话中"被杀掉 —— 补一条 turn/end（reason: 'crash'）让这轮闭合。
 *
 * 判断方式：最后一条 turn/start 出现在最后一条 turn/end 之后（或根本没有 turn/end）。
 * 崩溃现场最常见的形态是 turn/start 之后跟着 user/tool 就戛然而止 —— 所以不是只看
 * "末尾是不是 turn/start"，而是看配对是否完整。MVP 假设单轮串行，最多一个未闭合的 turn。
 *
 * 幂等性来自修复动作本身：补写的事件会被持久化，下一次 load 时配对已完整，不会再补。
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
    return { events: events as SessionEvent[], repaired: null }
  }
  const last = events.at(-1)!
  const repaired: SessionEvent = {
    seq: last.seq + 1,
    type: 'turn/end',
    ts: Date.now(),
    payload: { reason: 'crash' },
  }
  return { events: [...events, repaired], repaired }
}
