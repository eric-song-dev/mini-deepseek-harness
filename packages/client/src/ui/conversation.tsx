import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Context } from 'cordis'
import { projectConversation } from '../projection'
import { useSlotStore } from '../react'

/**
 * ui-conversation 插件（M4）：对话区——流式消息气泡 + composer。
 * 气泡全部由日志投影而来（user 事件 → 用户气泡；assistant/stream 分片 → 打字中的
 * 助手气泡；assistant 终事件封印成全文）。发消息只是调用 store.send，回声靠事件。
 *
 * 无会话空态（post-MVP UX）：chatbox 不渲染，中间给大的「＋ 新建会话」按钮，
 * 点它创建会话后 composer 出现并自动聚焦输入框。
 */

export function ConversationPanel() {
  const store = useSlotStore()
  const [draft, setDraft] = useState('')
  const messages = projectConversation(store.events)
  const hasSession = store.currentId !== null

  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // 吸底：新消息把视图滚到底部；用户上翻阅读时暂停（不再打扰）
  const [stickToBottom, setStickToBottom] = useState(true)

  // 新建/切换会话后自动聚焦输入框
  useEffect(() => {
    if (store.currentId !== null) inputRef.current?.focus()
  }, [store.currentId])

  // 消息变化时吸底（除非用户上翻；聊天区滚动修复后这是流式阅读的关键配套）
  useLayoutEffect(() => {
    if (stickToBottom && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages, stickToBottom])

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
  const onMessagesScroll = () => {
    const el = messagesRef.current
    if (!el) return
    // 距底部不足 80px 视为"在底部"，新消息继续吸底
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  // 无会话：chatbox 不渲染，中间给大的新建会话按钮
  if (!hasSession) {
    return (
      <div className="dsh-conversation dsh-conversation-start">
        <div className="dsh-start">
          <div className="dsh-start-title">开始一段新对话</div>
          <div className="dsh-start-hint">会话自动落盘保存，随时可以回来继续</div>
          <button className="dsh-start-session" onClick={() => void store.create()}>
            ＋ 新建会话
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="dsh-conversation">
      <div className="dsh-messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {messages.length === 0 && <div className="dsh-empty">开始和模型对话吧——输入消息，Enter 发送</div>}
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
          ref={inputRef}
          className="dsh-composer-input"
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="dsh-send"
          disabled={store.busy}
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
