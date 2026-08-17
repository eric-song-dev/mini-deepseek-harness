import { Context, Service } from 'cordis'
import { openSession } from './session'
import type { Session } from './session'
import { createHeaderEvent } from './events'
import { repairDanglingTurn } from './repair'
import { SessionNotFoundError } from './persistence'
import type { CreateSessionInput, SessionMeta, SessionPersistence } from './persistence'

/**
 * 会话管理服务：create / resume / list 的门面。
 *
 * - create：persistence.create 落盘 → openSession 挂起一个可 emit 的会话。
 * - resume：persistence.load 读回日志 → openSession 恢复（崩溃修复在任务 6 接入）。
 * - list：直接交给 persistence。
 *
 * 它是 cordis Service：声明 `inject: ['session-persistence']` 后，
 * 换后端（JSONL → SQLite）只是换提供服务的插件，SessionManager 本体零改动。
 */
export class SessionManager extends Service {
  static inject = ['session-persistence']

  constructor(ctx: Context) {
    super(ctx, 'session-manager')
  }

  private get persistence(): SessionPersistence {
    return this.ctx['session-persistence']
  }

  /** 新建会话（落盘 + 返回可 emit 的 Session）。 */
  async create(input: CreateSessionInput = {}): Promise<Session> {
    // M8 fork 种子：子会话头记录占 seq 1，父前缀平移为 2..N+1（载荷/类型/ts 原样）。
    // 平移在 manager 做（seq 语义归 session 包），后端只负责按原样写盘。
    const seed = input.seed?.map((event, index) => ({ ...event, seq: index + 2 }))
    const meta = seed === undefined
      ? await this.persistence.create(input)
      : await this.persistence.create({ ...input, seed })
    const events = seed === undefined ? undefined : [createHeaderEvent(meta), ...seed]
    return openSession(this.ctx, { id: meta.id, meta, persistence: this.persistence, ...(events === undefined ? {} : { events }) })
  }

  /** 重开会话：读回日志（含崩溃修复）并返回可继续追加的 Session；不存在抛 SessionNotFoundError。 */
  async resume(id: string): Promise<Session> {
    const loaded = await this.persistence.load(id)
    const { events, repaired } = repairDanglingTurn(loaded)
    // 修复可能补多条（悬空工具调用的 isError 结果 + turn/end），全部落盘保幂等
    for (const event of repaired) await this.persistence.append(id, event)
    const meta = await this.persistence.locate(id)
    if (!meta) throw new SessionNotFoundError(id)
    return openSession(this.ctx, { id, meta, persistence: this.persistence, events })
  }

  /** 列出全部会话（新的在前；同毫秒创建的先后不保证）。 */
  list(): Promise<SessionMeta[]> {
    return this.persistence.list()
  }
}

// 服务类型增强：插件可通过 `ctx['session-manager']` / `ctx.get('session-manager')` 取到。
declare module 'cordis' {
  interface Context {
    'session-manager': SessionManager
  }
}
