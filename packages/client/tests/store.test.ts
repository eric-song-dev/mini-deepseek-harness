import { describe, expect, it } from 'vitest'
import { createClientSessionStore } from '@mini-dsh/client'
import type { ClientBridge, ClientSessionStore } from '@mini-dsh/client'
import type { SessionEvent, SessionMeta } from '@mini-dsh/session'

/** scripted 桥：请求进日志、响应可编程、事件可手动触发（store 测试零网络）。 */
function scriptedBridge() {
  const requests: Array<{ method: string; params?: unknown }> = []
  const eventHandlers = new Set<(sessionId: string, event: SessionEvent) => void>()
  const responses = new Map<string, unknown | ((params: unknown) => unknown)>()
  const bridge: ClientBridge = {
    request: async (method, params) => {
      requests.push({ method, params })
      const respond = responses.get(method)
      if (typeof respond === 'function') return respond(params)
      return respond
    },
    onEvent: (handler) => {
      eventHandlers.add(handler)
      return () => {
        eventHandlers.delete(handler)
      }
    },
    close: () => {},
  }
  return {
    bridge,
    requests,
    respond(method: string, value: unknown | ((params: unknown) => unknown)) {
      responses.set(method, value)
    },
    emit(sessionId: string, event: SessionEvent) {
      for (const handler of eventHandlers) handler(sessionId, event)
    },
  }
}

const meta = (id: string, title = id): SessionMeta => ({ id, title, createdAt: 0 })
const header = (m: SessionMeta): SessionEvent => ({ seq: 1, type: 'session/created', ts: 0, payload: m })
const ev = (seq: number, type: SessionEvent['type'], payload: unknown): SessionEvent => ({ seq, type, ts: 0, payload })

describe('ClientSessionStore（M4：client 侧的日志投影缓存）', () => {
  it('初始快照：metas 空、currentId null、events 空、busy false', () => {
    const script = scriptedBridge()
    const store = createClientSessionStore(script.bridge)
    expect(store.metas).toEqual([])
    expect(store.currentId).toBeNull()
    expect(store.events).toEqual([])
    expect(store.busy).toBe(false)
  })

  it('list() 请求 session.list 并填充 metas；变更通知订阅者并递增版本', async () => {
    const script = scriptedBridge()
    script.respond('session.list', [meta('a'), meta('b')])
    const store = createClientSessionStore(script.bridge)
    let notified = 0
    store.subscribe(() => notified++)
    await store.list()
    expect(script.requests).toEqual([{ method: 'session.list', params: undefined }])
    expect(store.metas).toEqual([meta('a'), meta('b')])
    expect(store.version).toBe(1)
    expect(notified).toBe(1)
  })

  it('create() 请求 session.create，切到新会话（events 含头记录），metas 头部插入新会话', async () => {
    const script = scriptedBridge()
    script.respond('session.list', [meta('a')])
    script.respond('session.create', (params: unknown) => {
      const m = meta('new', (params as { title: string }).title)
      return { meta: m, events: [header(m)] }
    })
    const store = createClientSessionStore(script.bridge)
    await store.list()
    await store.create('新会话')
    expect(script.requests.map((r) => r.method)).toEqual(['session.list', 'session.create'])
    expect(script.requests[1]!.params).toEqual({ title: '新会话' })
    expect(store.currentId).toBe('new')
    expect(store.events).toEqual([header(meta('new', '新会话'))])
    expect(store.metas.map((m) => m.id)).toEqual(['new', 'a'])
  })

  it('open(id) 请求 session.resume，从返回历史恢复 events 并切换当前会话', async () => {
    const script = scriptedBridge()
    script.respond('session.resume', () => ({
      meta: meta('s1'),
      events: [header(meta('s1')), ev(2, 'turn/start', undefined), ev(3, 'user', { content: '历史问题' })],
    }))
    const store = createClientSessionStore(script.bridge)
    await store.open('s1')
    expect(script.requests).toEqual([{ method: 'session.resume', params: { id: 's1' } }])
    expect(store.currentId).toBe('s1')
    expect(store.events.map((e) => e.type)).toEqual(['session/created', 'turn/start', 'user'])
  })

  it('send(content)：busy 先 true 后 false，请求 session.send {id, content}；无当前会话直接抛错', async () => {
    const script = scriptedBridge()
    script.respond('session.create', () => ({ meta: meta('s1'), events: [header(meta('s1'))] }))
    script.respond('session.send', () => ({}))
    const store = createClientSessionStore(script.bridge)
    await expect(store.send('没会话')).rejects.toThrow(/当前会话/)

    await store.create('s')
    const busyDuring: boolean[] = []
    const pending = store.send('你好').then(() => busyDuring.push(store.busy))
    busyDuring.push(store.busy) // 请求期间（send 未 resolve 时）busy 应为 true
    await pending
    expect(busyDuring[0]).toBe(true)
    expect(busyDuring[1]).toBe(false)
    expect(store.busy).toBe(false)
    expect(script.requests.at(-1)).toEqual({ method: 'session.send', params: { id: 's1', content: '你好' } })
  })

  it('实时事件只追加当前会话的（其他会话忽略），每次追加通知订阅者', async () => {
    const script = scriptedBridge()
    script.respond('session.create', () => ({ meta: meta('s1'), events: [header(meta('s1'))] }))
    const store = createClientSessionStore(script.bridge)
    await store.create('s')
    let notified = 0
    store.subscribe(() => notified++)
    script.emit('other', ev(2, 'user', { content: '别人' }))
    expect(store.events).toHaveLength(1)
    expect(notified).toBe(0)
    script.emit('s1', ev(2, 'user', { content: '我的' }))
    expect(store.events.map((e) => e.type)).toEqual(['session/created', 'user'])
    expect(notified).toBe(1)
  })

  it('subscribe 返回取消订阅函数；取消后不再收到通知', async () => {
    const script = scriptedBridge()
    script.respond('session.create', () => ({ meta: meta('s1'), events: [header(meta('s1'))] }))
    const store: ClientSessionStore = createClientSessionStore(script.bridge)
    await store.create('s')
    let notified = 0
    const off = store.subscribe(() => notified++)
    script.emit('s1', ev(2, 'user', { content: '一' }))
    expect(notified).toBe(1)
    off()
    script.emit('s1', ev(3, 'user', { content: '二' }))
    expect(notified).toBe(1)
  })
})
