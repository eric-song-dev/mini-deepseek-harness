import 'cordis'
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
  /**
   * 会话工作目录（M3）：工具按它解析相对路径；缺省后端补进程 cwd。
   * 可选字段 = 兼容 M1/M2 的旧头记录（旧会话 resume 后由消费方兜底进程 cwd）。
   */
  cwd?: string
  /**
   * 谱系（M8）：派生本会话的父会话 id。subagent 子会话记"谁派生的我"；
   * 缺省 = 顶层会话（人类用户开的）。只记账不设限。
   */
  parentSessionId?: string
  /**
   * 谱系（M8）：委派深度。顶层 = 缺省（视为 0），每层 subagent 委派 +1。
   * 只记账不设限（上游 depthLimit 能力矩阵砍掉，见 M8 spec 决策 4）。
   */
  depth?: number
}

/** create 的输入：除 title 外都由后端补齐（id、createdAt、cwd）。 */
export interface CreateSessionInput {
  title?: string
  /** 会话工作目录；省略时后端用进程 cwd。 */
  cwd?: string
  /** 谱系（M8）：派生本会话的父会话 id。 */
  parentSessionId?: string
  /** 谱系（M8）：委派深度。 */
  depth?: number
  /**
   * fork 种子（M8）：父日志的"平衡已完成轮次前缀"（截至最后一个 turn/end 的
   * **轮次事件**，不含父头记录 session/created——子会话自己的头记录占 seq 1）。
   * manager 负责把 seq 平移（种子变 2..N+1）后交给后端；后端按原样追加在头记录之后。
   * 省略 = spawn（空对话开始）。
   */
  seed?: readonly SessionEvent[]
}

/**
 * 会话持久化 seam：日志落盘的抽象服务。
 *
 * 教学要点：会话的"真源"不是某个具体文件格式，而是这套契约。
 * JSONL 是第一个实现；SQLite（backlog #4）只需另写一个实现并通过同一份契约测试
 * （tests/contracts/persistence-contract.ts），agent loop 一行都不用改。
 */
export interface SessionPersistence {
  /** 按 id 查找会话元信息；不存在返回 undefined。 */
  locate(id: string): Promise<SessionMeta | undefined>
  /** 新建会话：分配 id/createdAt，写入头记录，返回完整 meta。 */
  create(input: CreateSessionInput): Promise<SessionMeta>
  /** 追加一条事件（按调用顺序落盘）。 */
  append(id: string, event: SessionEvent): Promise<void>
  /** 读回会话的完整事件日志（含头记录）；不存在抛 SessionNotFoundError。 */
  load(id: string): Promise<SessionEvent[]>
  /** 列出全部会话的 meta（按创建时间倒序，新的在前）。 */
  list(): Promise<SessionMeta[]>
}

/** 会话不存在（load/append 到未知 id 时抛出）。 */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在：${id}`)
    this.name = 'SessionNotFoundError'
  }
}

// 服务类型增强：插件可通过 `ctx['session-persistence']` / `ctx.get('session-persistence')` 取到 seam。
declare module 'cordis' {
  interface Context {
    'session-persistence': SessionPersistence
  }
}
