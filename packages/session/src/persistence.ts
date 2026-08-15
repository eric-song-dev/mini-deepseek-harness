import type { SessionEvent } from './events'

/**
 * 会话的元信息（JSONL 头记录的 payload，也是 list() 返回的元素）。
 */
export interface SessionMeta {
  /** 全局唯一会话 id；JSONL 后端同时用它做文件名 `<id>.jsonl`。 */
  id: string
  /** 会话标题（M1 由 create 时给定；M4 起 UI 可改）。 */
  title: string
  /** 创建时间（epoch 毫秒）。 */
  createdAt: number
}

/**
 * 会话持久化 seam（M1 契约的最小面）：Session 的桥接每次 emit 后调用 append。
 * 完整契约（locate/create/load/list）由任务 4 的契约测试驱动补全；
 * JSONL 是第一个实现，SQLite（backlog #4）只换实现。
 */
export interface SessionPersistence {
  /** 追加一条事件到指定会话（按调用顺序落盘）。 */
  append(id: string, event: SessionEvent): Promise<void>
}
