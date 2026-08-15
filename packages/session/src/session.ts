import type { Context, Events } from 'cordis'
import { EventsService } from 'cordis'
import { createHeaderEvent, SESSION_EVENT_NAMES } from './events'
import type { SessionEvent, SessionEventType } from './events'
import type { SessionMeta, SessionPersistence } from './persistence'

export interface SessionConfig {
  /** 会话 id（与 persistence.create 返回的 meta.id 一致）。 */
  id: string
  /** 会话元信息。 */
  meta: SessionMeta
  /** 持久化后端（seam）；不传则纯内存（测试用）。 */
  persistence?: SessionPersistence
  /** 已加载的历史事件（resume 时注入）；不传则视为新会话，日志从头记录 session/created 开始。 */
  events?: readonly SessionEvent[]
}

/**
 * 日志真源的只读入口（会话 ctx 上的 `session-log` 服务）。
 *
 * 输出侧：词汇事件经桥接追加进日志；输入侧：loop 等消费者从这里读快照做投影。
 * 快照是副本——拿到后日志继续追加不会改变旧快照，改快照也动不了日志。
 * M5 的 Trajectory 投影同样从这里读（同一个真源，不同视图）。
 */
export interface SessionLog {
  readonly events: readonly SessionEvent[]
}

/**
 * 一个会话 = 一段 append-only 事件日志 + 一个挂桥接监听器的子 ctx。
 *
 * 桥接模型（M1 关键设计）：agent/测试插件在**会话自己的 ctx** 上 emit 词汇事件，
 * Session 内部把事件**同步**追加进日志（内存 + persistence），emit 方不知道谁在记录。
 * 日志是唯一真源；dispose 时桥接随 fiber 一起摘除。
 */
export class Session {
  readonly ctx: Context
  readonly id: string
  readonly meta: SessionMeta

  private readonly events: SessionEvent[] = []
  private readonly persistence: SessionPersistence | undefined
  private nextSeq = 1
  /** 追加链：保证 append 按 emit 顺序落盘（链上吞掉失败，避免断链）。 */
  private pendingWrites: Promise<void> = Promise.resolve()
  /** 最近一次真实写入（flush 的等待目标；失败会向 flush 方暴露）。 */
  private lastWrite: Promise<void> = this.pendingWrites

  constructor(ctx: Context, config: SessionConfig) {
    this.ctx = ctx
    this.id = config.id
    this.meta = config.meta
    this.persistence = config.persistence

    const initial = config.events ?? [createHeaderEvent(config.meta)]
    this.events.push(...initial)
    this.nextSeq = (this.events.at(-1)?.seq ?? 0) + 1

    // 日志真源的只读入口：消费方（M2 的 loop、M5 的投影）从会话 ctx 读日志快照，
    // 而不是去拿 Session 对象——"输出写日志、输入读日志"都走会话 ctx 的服务。
    // 注意：cordis 的服务键按根 ctx 作用域唯一（isolate 链共享），并存会话若各自
    // ctx.provide('session-log') 会撞键（第二会话报"already registered"）；
    // 与 events 同款处理——defineProperty 定义会话 ctx 自有属性遮蔽继承链。
    const self = this
    Object.defineProperty(ctx, 'session-log', {
      value: {
        get events() {
          return [...self.events]
        },
      },
      configurable: true,
    })

    // 会话元信息的只读入口（M3）：loop 从它取工具执行用的 cwd（meta.cwd，旧会话缺省
    // 由消费方兜底进程 cwd）。与 session-log 同款 defineProperty 遮蔽。
    Object.defineProperty(ctx, 'session-meta', {
      value: self.meta,
      configurable: true,
    })

    // 隔离：会话拥有自己的事件总线实例。子 ctx 沿原型链共享根 ctx 的 EventsService，
    // 若不隔离，同一 runtime 下多个并存会话会互相收到对方的 emit（桥接串台）。
    // ctx 代理不允许直接赋值（无 provide），用 defineProperty 定义自有属性覆盖继承来的实例。
    Object.defineProperty(ctx, 'events', { value: new EventsService(ctx), configurable: true })

    // 桥接监听器：会话 ctx 上的词汇事件 → append 日志。
    // ctx.on 注册的监听器是当前 fiber 的 effect，dispose 时自动摘除。
    for (const name of SESSION_EVENT_NAMES) {
      const handler = ((...args: unknown[]) => {
        this.append(name, args[0])
      }) as Events[keyof Events]
      ctx.on(name as keyof Events, handler)
    }
  }

  /** append-only 日志（只读视图；新条目只能由桥接追加）。 */
  get log(): readonly SessionEvent[] {
    return this.events
  }

  /** 等待所有已 emit 的事件落盘完成（测试与 demo 用它在读文件前同步）。 */
  flush(): Promise<void> {
    return this.lastWrite
  }

  /** 落盘排空后关掉会话 ctx（桥接摘除，之后 emit 不再记录）。 */
  async dispose(): Promise<void> {
    await this.flush()
    await this.ctx.fiber.dispose()
  }

  private append(type: SessionEventType, payload: unknown) {
    const event: SessionEvent = { seq: this.nextSeq++, type, ts: Date.now(), payload }
    this.events.push(event)
    const persistence = this.persistence
    if (!persistence) return
    const write = this.pendingWrites.then(() => persistence.append(this.id, event))
    write.catch((error) => {
      this.ctx.logger.warn(`会话 ${this.id} 事件 #${event.seq} 落盘失败`, error)
    })
    this.lastWrite = write
    this.pendingWrites = write.catch(() => {})
  }
}

/**
 * 打开一个会话：作为插件挂到 parent ctx 上，得到自己的子 ctx（继承根的服务）
 * 与独立的 fiber 生命周期。会话本身也是插件 —— "一切皆为插件"连会话也不例外。
 */
export async function openSession(parent: Context, config: SessionConfig): Promise<Session> {
  let session: Session | undefined
  await parent.plugin(function sessionRuntime(ctx: Context) {
    session = new Session(ctx, config)
  })
  if (!session) throw new Error('openSession: 会话插件装载失败')
  return session
}

// 服务类型增强：会话 ctx 上可经 `ctx['session-log']` 取到日志只读入口
// （自有属性遮蔽，不经 cordis 服务注册表，见 Session 构造器的说明）。
declare module 'cordis' {
  interface Context {
    'session-log': SessionLog
    'session-meta': SessionMeta
  }
}
