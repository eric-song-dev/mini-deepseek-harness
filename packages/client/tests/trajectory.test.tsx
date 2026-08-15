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
import type { SessionEvent } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createRpcBridge, memoryConnectionPair, webHost } from '@mini-dsh/web'
import {
  ClientRoot,
  clientShell,
  createBridgeClient,
  uiConversation,
  uiSessionList,
  uiTool,
  uiTrajectory,
} from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * ui-trajectory 测试（M5，jsdom）：slot `trajectory` 进 extras 区（shell 不改），
 * 按轮事件表 + 点选检查器。真 host（内存桥）+ M4 台词（工具往返 + 流式分片）驱动
 * 整条链路；旧日志 fixture 验证 usage 兜底显示 `—`。
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

/** 组装真 host（内存桥）+ 全量 client UI（含轨迹面板）。 */
async function makeUi(options: {
  chunkDelay?: number
  replies?: Parameters<typeof createFakeLlm>[0]['replies']
} = {}) {
  const { ctx, dispose } = await createTestContext()
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-client-trajectory-'))
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const chunkDelay = options.chunkDelay ?? 0
  const replies = options.replies ?? [
    { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
    { chunks: ['你', '好', '呀'], chunkDelay },
  ]
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
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
  await clientCtx.plugin(uiTrajectory)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ClientRoot ctx={clientCtx} />)
  })
  roots.push(root)
  cleanups.push(async () => {
    await ctx.get('web-host')!.close()
    await dispose()
  })
  return { clientCtx, container }
}

async function createSession(): Promise<void> {
  click('.dsh-new-session')
  await waitFor(() => document.querySelectorAll('.dsh-session-item').length === 1, '会话出现在列表')
}

async function sendMessage(content: string): Promise<void> {
  typeInto('.dsh-composer-input', content)
  click('.dsh-send')
  await waitFor(() => {
    const sendButton = document.querySelector('.dsh-send') as HTMLButtonElement | null
    return sendButton !== null && !sendButton.disabled
  }, '轮次结束（发送按钮恢复可用）')
}

/** 跑一轮 M4 台词对话（工具往返 + 流式分片）。 */
async function runTurn(content: string): Promise<void> {
  await createSession()
  await sendMessage(content)
  await waitFor(() => textOf('.dsh-bubble.dsh-assistant') === '你好呀', '最终全文渲染')
}

describe('ui-trajectory（M5：轨迹面板，slot trajectory）', () => {
  it('slot trajectory 装配进 extras 区（shell 一行不改）；空会话显示空态', async () => {
    await makeUi()
    expect(document.querySelector('.dsh-extras [data-slot="trajectory"]')).not.toBeNull()
    expect(textOf('[data-slot="trajectory"] .dsh-trajectory-empty')).toContain('还没有轮次')
  })

  it('M4 台词跑完一轮：轨迹表一行（轮号/user 文本/事件数/耗时非负），明细含分片聚合行', async () => {
    await makeUi({ chunkDelay: 15 })
    await runTurn('帮我回显')

    // 轮表：一行，四个字段齐全
    const rows = document.querySelectorAll('.dsh-turn-row')
    expect(rows).toHaveLength(1)
    const row = rows.item(0)!
    expect(row.querySelector('.dsh-turn-cell-index')?.textContent).toContain('1')
    expect(row.querySelector('.dsh-turn-cell-user')?.textContent).toContain('帮我回显')
    // 事件数：user + assistant(要工具) + tool×2 + 分片聚合 + assistant 终事件 = 6
    expect(row.querySelector('.dsh-turn-cell-count')?.textContent).toContain('6')
    const duration = Number(/\d+/.exec(row.querySelector('.dsh-turn-cell-duration')?.textContent ?? '')?.[0])
    expect(Number.isFinite(duration)).toBe(true)
    expect(duration).toBeGreaterThanOrEqual(0)

    // 展开轮 → 事件明细；分片聚合行显示"流式 ×3"
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => document.querySelectorAll('.dsh-turn-event').length === 6, '事件明细展开')
    const streamRow = document.querySelector('.dsh-turn-event[data-type="assistant/stream"]')
    expect(streamRow?.textContent).toContain('流式 ×3')
  })

  it('点选 tool 调用事件 → 检查器显示 input 与配对结果 output（调用/结果对高亮配对）', async () => {
    await makeUi()
    await runTurn('帮我回显')

    click('.dsh-turn-row')
    await waitFor(() => document.querySelectorAll('.dsh-turn-event').length === 6, '事件明细展开')
    // 第一个 tool 事件是调用（无 output）
    click('.dsh-turn-event[data-type="tool"]')
    const inspector = document.querySelector('.dsh-inspector')!
    await waitFor(() => inspector.querySelector('.dsh-inspector-payload') !== null, '检查器渲染')
    expect(inspector.querySelector('.dsh-inspector-title')?.textContent).toContain('tool')
    expect(inspector.querySelector('.dsh-inspector-payload')?.textContent).toContain('"text": "喂"')
    // 配对：调用事件点开后能同时看到结果 output（同一轮、同名 tool）
    expect(inspector.querySelector('.dsh-inspector-pair')?.textContent).toContain('"echoed": "喂"')
  })

  it('点选 assistant 事件 → 检查器显示 token 用量；旧日志 fixture 兜底显示 —', async () => {
    await makeUi()
    await runTurn('帮我回显')

    click('.dsh-turn-row')
    await waitFor(() => document.querySelectorAll('.dsh-turn-event').length === 6, '事件明细展开')
    click('.dsh-turn-event[data-type="assistant"]')
    const inspector = document.querySelector('.dsh-inspector')!
    await waitFor(() => inspector.querySelector('.dsh-inspector-usage') !== null, 'usage 渲染')
    expect(inspector.querySelector('.dsh-inspector-usage')?.textContent).toContain('输入 1 tokens')
    expect(inspector.querySelector('.dsh-inspector-usage')?.textContent).toContain('输出 1 tokens')
  })

  it('实时追加：第二轮结束后轨迹表两行，轮号递增', async () => {
    await makeUi({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: '喂' } }] },
        { chunks: ['你', '好', '呀'] },
        { content: '第二答' },
      ],
    })
    await runTurn('帮我回显')
    expect(document.querySelectorAll('.dsh-turn-row')).toHaveLength(1)

    await sendMessage('再聊一句')
    await waitFor(() => document.querySelectorAll('.dsh-turn-row').length === 2, '第二轮出现在轨迹表')
    const rows = document.querySelectorAll('.dsh-turn-row')
    expect(rows.item(0)!.querySelector('.dsh-turn-cell-index')?.textContent).toContain('1')
    expect(rows.item(1)!.querySelector('.dsh-turn-cell-index')?.textContent).toContain('2')
  })

  it('旧日志 fixture（M2–M4 无 usage）：检查器显示 token 用量为 —，不崩', async () => {
    const fixtureEvents: SessionEvent[] = [
      { seq: 1, type: 'session/created', ts: 0, payload: { id: 'old', title: '旧会话', createdAt: 0 } },
      { seq: 2, type: 'turn/start', ts: 10, payload: undefined },
      { seq: 3, type: 'user', ts: 11, payload: { content: '旧问题' } },
      { seq: 4, type: 'assistant', ts: 12, payload: { content: '旧回复' } },
      { seq: 5, type: 'turn/end', ts: 13, payload: { reason: 'done' } },
    ]
    const fixtureBridge: ClientBridge = {
      request: async <T,>(method: string): Promise<T> => {
        if (method === 'session.resume') return { meta: fixtureEvents[0]!.payload, events: fixtureEvents } as T
        throw new Error(`fixture 桥不处理 ${method}`)
      },
      onEvent: () => () => {},
      close: () => {},
    }
    const clientCtx = new Context()
    await clientCtx.plugin(clientShell, { bridge: fixtureBridge })
    await clientCtx.plugin(uiTrajectory)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<ClientRoot ctx={clientCtx} />)
    })
    roots.push(root)

    await act(async () => {
      await clientCtx.get('client-session-store')!.open('old')
    })
    expect(document.querySelectorAll('.dsh-turn-row')).toHaveLength(1)

    click('.dsh-turn-row')
    await waitFor(() => document.querySelectorAll('.dsh-turn-event').length === 2, '旧日志事件明细')
    click('.dsh-turn-event[data-type="assistant"]')
    const inspector = document.querySelector('.dsh-inspector')!
    await waitFor(() => inspector.querySelector('.dsh-inspector-usage') !== null, 'usage 兜底渲染')
    expect(inspector.querySelector('.dsh-inspector-usage')?.textContent).toContain('—')
  })
})
