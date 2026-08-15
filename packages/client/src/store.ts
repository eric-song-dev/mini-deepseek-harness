import type { SessionEvent, SessionMeta } from '@mini-dsh/session'
import type { ClientBridge } from './connection'

/**
 * client 侧的会话状态（M4）："client 只是日志的又一个消费者"的落地。
 *
 * 会话列表、当前会话日志、忙碌状态都从这里取；数据全部来自 host（RPC 应答 +
 * 实时事件推送），store 自己不再发明第二份状态。变更通过 version + subscribe
 * 通知（React 的 useSyncExternalStore 直接消费这两个成员）。
 */
export interface ClientSessionStore {
  /** 会话列表（新的在前；list() 填充）。 */
  readonly metas: readonly SessionMeta[]
  /** 当前会话 id；没有打开任何会话时为 null。 */
  readonly currentId: string | null
  /** 当前会话的事件日志（append-only 快照副本）。 */
  readonly events: readonly SessionEvent[]
  /** 是否有发送中的轮次（composer 禁用发送按钮）。 */
  readonly busy: boolean
  /** 单调递增的版本号：每次状态变更 +1（React 快照源）。 */
  readonly version: number
  /** 拉取会话列表。 */
  list(): Promise<void>
  /** 新建会话（title 缺省由 host 补默认标题）并切换过去。 */
  create(title?: string): Promise<void>
  /** 打开（resume）会话：host 返回完整历史，切换过去。 */
  open(id: string): Promise<void>
  /** 向当前会话发消息（host 触发 loop，事件实时推回）。 */
  send(content: string): Promise<void>
  /** 订阅状态变更；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void
}

/** create/resume 的共同应答形状（meta + 完整日志）。 */
interface SessionPayload {
  meta: SessionMeta
  events: readonly SessionEvent[]
}

export function createClientSessionStore(bridge: ClientBridge): ClientSessionStore {
  let metas: readonly SessionMeta[] = []
  let currentId: string | null = null
  let events: readonly SessionEvent[] = []
  let busy = false
  let version = 0
  const listeners = new Set<() => void>()

  const notify = (): void => {
    version++
    for (const listener of [...listeners]) listener()
  }

  // 实时事件：只追加当前会话的（多 client 共享一条桥，各自过滤自己关心的会话）
  bridge.onEvent((sessionId, event) => {
    if (sessionId !== currentId) return
    events = [...events, event]
    notify()
  })

  return {
    get metas() {
      return metas
    },
    get currentId() {
      return currentId
    },
    get events() {
      return events
    },
    get busy() {
      return busy
    },
    get version() {
      return version
    },
    async list() {
      metas = (await bridge.request('session.list')) as SessionMeta[]
      notify()
    },
    async create(title) {
      const payload = await bridge.request<SessionPayload>(
        'session.create',
        title === undefined ? undefined : { title },
      )
      currentId = payload.meta.id
      events = [...payload.events]
      metas = [payload.meta, ...metas]
      notify()
    },
    async open(id) {
      const payload = await bridge.request<SessionPayload>('session.resume', { id })
      currentId = payload.meta.id
      events = [...payload.events]
      notify()
    },
    async send(content) {
      if (currentId === null) throw new Error('还没有当前会话：先新建或打开一个会话')
      busy = true
      notify()
      try {
        await bridge.request('session.send', { id: currentId, content })
      } finally {
        busy = false
        notify()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
