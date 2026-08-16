import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createFakeLlm, createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createRpcBridge, memoryConnectionPair, webHost } from '@mini-dsh/web'
import { ClientRoot, clientShell, createBridgeClient, uiConversation, uiSessionList, uiTool } from '@mini-dsh/client'

/**
 * UI 集成测试（M4）：真 host（内存桥，零网络）+ 真 client 装配 + jsdom 渲染。
 * 假 LLM 台词本（工具往返 + 流式分片）驱动整条链路——这就是"浏览器里完成一次
 * 真实对话"的自动化替身；人工浏览器验收交给 demo 与教程练习。
 */

let roots: Root[] = []
let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  for (const cleanup of cleanups.splice(0)) await cleanup()
  document.body.innerHTML = ''
})

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent ?? ''
}

/** 组装真 host（内存桥）+ client UI（jsdom）；extraPlugins 在渲染前追加注册（Slot 练习用）。 */
async function makeUi(options: {
  replies: Parameters<typeof createFakeLlm>[0]['replies']
  chunkDelay?: number
  extraPlugins?: Array<(ctx: Context) => void>
}) {
  const { ctx, dispose } = await createTestContext()
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-client-ui-'))
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const replies = options.replies.map((reply) =>
    reply.chunks && options.chunkDelay ? { ...reply, chunkDelay: options.chunkDelay } : reply,
  )
  await ctx.plugin(provideLlm, createFakeLlm({ replies }))
  await ctx.plugin(toolRegistry)
  ctx.get('tools')!.register({
    declaration: {
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    execute: async (input: Record<string, unknown>) => ({ echoed: input.text }),
  })
  const [hostSide, clientSide] = memoryConnectionPair()
  const bridge = createRpcBridge()
  bridge.accept(hostSide)
  await ctx.plugin(webHost, { port: 0, bridge, stream: true })

  const clientCtx = new Context()
  await clientCtx.plugin(clientShell, { bridge: createBridgeClient(clientSide) })
  await clientCtx.plugin(uiSessionList)
  await clientCtx.plugin(uiConversation)
  await clientCtx.plugin(uiTool)
  for (const plugin of options.extraPlugins ?? []) await clientCtx.plugin(plugin)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ClientRoot ctx={clientCtx} />)
  })
  roots.push(root)
  cleanups.push(async () => {
    await dispose()
  })
  return { clientCtx, container }
}

function click(selector: string) {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`找不到元素：${selector}`)
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function typeInto(selector: string, value: string) {
  const element = document.querySelector(selector) as HTMLTextAreaElement | null
  if (!element) throw new Error(`找不到元素：${selector}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('client UI 装配（jsdom，M4）', () => {
  it('三个 slot 面板按装配位渲染（会话列表 / 对话区 / 工具区）', async () => {
    await makeUi({ replies: [{ content: '你好' }] })
    expect(document.querySelector('.dsh-area-list .dsh-new-session')).not.toBeNull()
    // 无会话启动：chatbox 不渲染，中间是大的新建会话按钮
    expect(document.querySelector('.dsh-area-chat .dsh-composer')).toBeNull()
    expect(textOf('.dsh-area-chat .dsh-start-session')).toContain('新建会话')
    expect(textOf('.dsh-area-list .dsh-session-empty')).toContain('还没有会话')
    expect(textOf('.dsh-area-tools .dsh-tool-empty')).toContain('还没有工具活动')
  })

  it('中间大按钮点一下即创建会话：composer 出现并自动聚焦输入框', async () => {
    await makeUi({ replies: [{ content: '你好' }] })
    click('.dsh-start-session')
    await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 1, '会话出现在列表')
    expect(document.querySelector('.dsh-composer')).not.toBeNull()
    await waitFor(() => document.activeElement === document.querySelector('.dsh-composer-input'), '输入框自动聚焦')
  })

  it('有会话但还没有消息时提示语友好（不再说"新建或选择一个会话"）', async () => {
    await makeUi({ replies: [{ content: '你好' }] })
    click('.dsh-start-session')
    await waitFor(() => document.querySelector('.dsh-composer-input') !== null, 'composer 出现')
    expect(textOf('.dsh-empty')).toContain('开始')
    expect(textOf('.dsh-empty')).not.toContain('新建或选择')
  })

  it('新消息追加时消息区自动吸底；用户上翻阅读后不再吸底', async () => {
    await makeUi({ replies: [{ content: '回答一' }, { content: '回答二' }] })
    click('.dsh-start-session')
    await waitFor(() => document.querySelector('.dsh-composer-input') !== null, 'composer 出现')

    // jsdom 无布局引擎：接管 scrollHeight/scrollTop 观察吸底行为
    const box = document.querySelector('.dsh-messages')!
    let scrolled = -1
    Object.defineProperty(box, 'scrollHeight', { get: () => 500, configurable: true })
    Object.defineProperty(box, 'scrollTop', {
      get: () => scrolled,
      set: (value: number) => {
        scrolled = value
      },
      configurable: true,
    })

    typeInto('.dsh-composer-input', '问题一')
    click('.dsh-send')
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '回答一', '回答一')
    expect(scrolled).toBe(500)

    // 用户上翻（远离底部）：后续消息不再打扰
    scrolled = 0
    box.dispatchEvent(new Event('scroll'))
    typeInto('.dsh-composer-input', '问题二')
    click('.dsh-send')
    await waitFor(() => document.querySelectorAll('.dsh-bubble.dsh-assistant').length === 2, '回答二')
    expect(scrolled).toBe(0)
  })

  it('未列入主布局的 slot 也会被装配进 extras 区：加 ui 插件不改 shell', async () => {
    const ExtraPanel = () => <div className="my-extra">我是额外面板</div>
    const myExtraPlugin = Object.assign(
      function myExtraPlugin(ctx: Context): void {
        ctx['slot-registry'].register('my-panel', ExtraPanel)
      },
      { inject: ['slot-registry'] },
    )
    await makeUi({ replies: [{ content: '你好' }], extraPlugins: [myExtraPlugin] })
    expect(textOf('.dsh-extras [data-slot="my-panel"] .my-extra')).toBe('我是额外面板')
  })

  it('新建会话后左侧列表项显示会话名字（缺省 title 不再空白）', async () => {
    await makeUi({ replies: [{ content: '你好' }] })
    click('.dsh-new-session')
    await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 1, '会话出现在列表')
    const title = textOf('.dsh-session-item .dsh-session-title')
    expect(title.length).toBeGreaterThan(0)
    expect(title).toMatch(/^新会话/)
  })

  it('完整对话流：新建会话 → 发消息 → 流式分片打字机 → 气泡封印 → tool 卡片出现', async () => {
    await makeUi({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
        { chunks: ['你', '好', '呀'] },
      ],
      chunkDelay: 20,
    })

    click('.dsh-new-session')
    await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 1, '会话出现在列表')

    typeInto('.dsh-composer-input', '帮我回显')
    click('.dsh-send')

    // 用户消息回声（来自日志，不是本地拼接）
    await waitFor(() => document.querySelectorAll('.dsh-bubble.dsh-user').length === 1, '用户气泡出现')

    // 流式中途：第一个分片到达时气泡处于打字中状态
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant').includes('你'), '第一个分片渲染')
    expect(document.querySelector('.dsh-bubble.dsh-assistant')?.className).toContain('dsh-streaming')

    // 终事件封印：全文呈现、打字中状态摘除
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '你好呀', '最终全文渲染')
    expect(document.querySelector('.dsh-bubble.dsh-assistant')?.className).not.toContain('dsh-streaming')

    // tool 卡片：调用 input 与结果 output 都在
    await waitFor(() => document.querySelectorAll('.dsh-tool-card').length === 1, 'tool 卡片出现')
    const card = document.querySelector('.dsh-tool-card')!
    expect(card.textContent).toContain('echo')
    expect(card.textContent).not.toContain('执行中')
    expect(card.textContent).toContain('"text": "喂"')
    expect(card.textContent).toContain('"echoed": "喂"')

    // 发送按钮在轮次结束后恢复可用
    const sendButton = document.querySelector('.dsh-send') as HTMLButtonElement
    expect(sendButton.disabled).toBe(false)
  })

  it('会话切换：两个会话互不串台，切回旧会话历史完整（resume 路径）', async () => {
    await makeUi({ replies: [{ content: '回答一' }, { content: '回答二' }] })

    click('.dsh-new-session')
    await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 1, '会话一创建')
    typeInto('.dsh-composer-input', '问题一')
    click('.dsh-send')
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '回答一', '会话一回答')

    click('.dsh-new-session')
    await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 2, '会话二创建')
    await waitFor(() => document.querySelectorAll('.dsh-bubble').length === 0, '会话二对话区为空')
    typeInto('.dsh-composer-input', '问题二')
    click('.dsh-send')
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '回答二', '会话二回答')

    // 切回会话一：resume 拉回完整历史（列表按"新的在前"排序，会话一在第二位）
    const items = document.querySelectorAll('.dsh-session-item')
    expect(items).toHaveLength(2)
    items.item(1)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '回答一', '切回会话一历史完整')
    expect(document.querySelectorAll('.dsh-bubble.dsh-user')[0]?.textContent).toBe('问题一')
  })
})
