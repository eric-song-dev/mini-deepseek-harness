import type { SessionEvent } from './events'

export interface RepairResult {
  /** 修复后的完整日志（没有断尾时就是原数组引用）。 */
  events: SessionEvent[]
  /** 补写出的 turn/end；无需修复时为 null。 */
  repaired: SessionEvent | null
}

/**
 * 崩溃恢复的纯函数核心：日志若以 turn/start 收尾（没有配对的 turn/end），
 * 说明进程在"一轮对话中"被杀掉 —— 补一条 turn/end（reason: 'crash'）让日志闭合。
 *
 * 幂等性来自修复动作本身：补写的事件会被持久化，下一次 load 末尾就是 turn/end，
 * 不会再补。只检查最后一条（MVP 假设单轮串行，没有嵌套 turn）。
 */
export function repairDanglingTurn(events: readonly SessionEvent[]): RepairResult {
  const last = events.at(-1)
  if (!last || last.type !== 'turn/start') {
    return { events: events as SessionEvent[], repaired: null }
  }
  const repaired: SessionEvent = {
    seq: last.seq + 1,
    type: 'turn/end',
    ts: Date.now(),
    payload: { reason: 'crash' },
  }
  return { events: [...events, repaired], repaired }
}
