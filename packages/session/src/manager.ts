import { Context, Service } from 'cordis'
import { openSession } from './session'
import type { Session } from './session'
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
    const meta = await this.persistence.create(input)
    return openSession(this.ctx, { id: meta.id, meta, persistence: this.persistence })
  }

  /** 重开会话：读回日志并返回可继续追加的 Session；不存在抛 SessionNotFoundError。 */
  async resume(id: string): Promise<Session> {
    const events = await this.persistence.load(id)
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
