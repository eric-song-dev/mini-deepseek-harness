import type { Context, Events } from 'cordis'

export interface RecordedEvent {
  /** 事件名。 */
  name: string
  /** 事件载荷（原始参数列表）。 */
  args: unknown[]
  /** 全局单调递增的发生顺序号。 */
  seq: number
}

export interface EventRecorder {
  /** 全部已记录事件，按发生顺序。 */
  readonly events: readonly RecordedEvent[]
  /** 过滤出指定事件名的记录。 */
  eventsOf(name: string): RecordedEvent[]
  /** 指定事件名的最近一条记录；没有则返回 undefined。 */
  last(name: string): RecordedEvent | undefined
  /** 清空记录。 */
  clear(): void
  /** 摘除监听器。 */
  dispose(): void
}

/**
 * 挂一个事件记录器到 ctx：只监听 names 里的事件，记录载荷与发生顺序。
 * 这是全项目"断言 session 事件日志"的基础工具（M1 起用于事件词汇的契约测试）。
 */
export function createEventRecorder(ctx: Context, names: readonly string[]): EventRecorder {
  let seq = 0
  const events: RecordedEvent[] = []
  // 记录器是"任意事件名"的通用工具：事件名在运行时才知道，
  // 而 ctx.on 的类型按 keyof Events 收窄，这里显式放宽（类型增强见 M1 的事件词汇）。
  const offs = names.map((name) =>
    ctx.on(
      name as keyof Events,
      ((...args: unknown[]) => {
        events.push({ name, args, seq: seq++ })
      }) as Events[keyof Events],
    ),
  )

  return {
    events,
    eventsOf(name) {
      return events.filter((event) => event.name === name)
    },
    last(name) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.name === name) return events[i]
      }
      return undefined
    },
    clear() {
      events.length = 0
    },
    dispose() {
      for (const off of offs) off()
    },
  }
}
