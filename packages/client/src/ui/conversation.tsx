import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Context } from 'cordis'
import { projectConversation } from '../projection'
import { useSlotStore } from '../react'

/**
 * ui-conversation 插件（M4）：对话区——流式消息气泡 + composer。
 * 气泡全部由日志投影而来（user 事件 → 用户气泡；assistant/stream 分片 → 打字中的
 * 助手气泡；assistant 终事件封印成全文）。发消息只是调用 store.send，回声靠事件。
 */

export function ConversationPanel() {
  const store = useSlotStore()
  const [draft, setDraft] = useState('')
  const messages = projectConversation(store.events)

  const send = () => {
    const content = draft.trim()
    if (content === '') return
    setDraft('')
    void store.send(content)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="dsh-conversation">
      <div className="dsh-messages">
        {messages.length === 0 && <div className="dsh-empty">新建或选择一个会话，开始对话</div>}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`dsh-bubble dsh-${message.role}${message.streaming ? ' dsh-streaming' : ''}`}
          >
            {message.content}
          </div>
        ))}
      </div>
      <div className="dsh-composer">
        <textarea
          className="dsh-composer-input"
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="dsh-send"
          disabled={store.busy || store.currentId === null}
          onClick={send}
        >
          {store.busy ? '回复中…' : '发送'}
        </button>
      </div>
    </div>
  )
}

/** 注册插件：把面板注册进 slot-registry（shell 负责装配）。 */
export const uiConversation = Object.assign(
  function uiConversation(ctx: Context): void {
    ctx['slot-registry'].register('conversation', ConversationPanel)
},
  { inject: ['slot-registry'] },
)
