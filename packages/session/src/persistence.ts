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
