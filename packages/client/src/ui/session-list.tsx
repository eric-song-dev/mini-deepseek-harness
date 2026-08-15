import { useEffect } from 'react'
import type { Context } from 'cordis'
import { useSlotStore } from '../react'

/**
 * ui-session-list 插件（M4）：会话列表——新建 / resume / 切换。
 * 它只认 client-session-store 服务，不认 WebSocket、不认 host 的实现细节。
 */

export function SessionListPanel() {
  const store = useSlotStore()
  useEffect(() => {
    void store.list()
  }, [store])

  return (
    <div className="dsh-session-list">
      <button className="dsh-new-session" onClick={() => void store.create()}>
        ＋ 新建会话
      </button>
      {store.metas.map((meta) => (
        <div
          key={meta.id}
          className={`dsh-session-item${meta.id === store.currentId ? ' dsh-active' : ''}`}
          onClick={() => void store.open(meta.id)}
        >
          <div className="dsh-session-title">{meta.title}</div>
        </div>
      ))}
    </div>
  )
}

/** 注册插件：把面板注册进 slot-registry（shell 负责装配）。 */
export const uiSessionList = Object.assign(
  function uiSessionList(ctx: Context): void {
    ctx['slot-registry'].register('session-list', SessionListPanel)
},
  { inject: ['slot-registry'] },
)
