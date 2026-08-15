/**
 * M4 教程练习（进阶）：脚本化客户端——不点浏览器，用代码完成一次"真实对话"并断言事件序列。
 *
 * 用法（两个终端）：
 *   终端 1：pnpm demo:web            # 起真 host（假 LLM 台词本）
 *   终端 2：pnpm tsx packages/web/examples/my-ws-client.ts
 * 可选参数：--url ws://127.0.0.1:8080
 *
 * 玩法（红绿翻转）：改动 packages/web/examples/web-demo.ts 的台词本（比如删一个分片），
 * 重启 demo:web，再跑本脚本——EXPECTED_TYPES 断言变红；把断言跟着改对，回绿。
 * 这就是"浏览器里那次对话"的代码替身：同一份事件日志，两种消费方式。
 */
import WebSocket from 'ws'

const args = process.argv.slice(2)
const urlIndex = args.indexOf('--url')
const url = urlIndex >= 0 && args[urlIndex + 1] ? args[urlIndex + 1]! : 'ws://127.0.0.1:8080'

// demo 台词本的完整事件序列：turn/start → user → assistant（要工具）→ tool 调用 →
// tool 结果 → 5 个流式分片 → assistant（全文）→ turn/end
const EXPECTED_TYPES = [
  'turn/start',
  'user',
  'assistant',
  'tool',
  'tool',
  'assistant/stream',
  'assistant/stream',
  'assistant/stream',
  'assistant/stream',
  'assistant/stream',
  'assistant',
  'turn/end',
]

interface ResponseMessage {
  kind: 'response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { name: string; message: string }
}

async function main(): Promise<void> {
  console.log(`连接 ${url} …（先确认终端 1 的 pnpm demo:web 在跑）`)
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', (error) => reject(new Error(`连接失败：${(error as Error).message}\n先起 pnpm demo:web`)))
  })

  const pending = new Map<string, (message: ResponseMessage) => void>()
  let nextId = 0
  const request = (method: string, params?: unknown): Promise<ResponseMessage> =>
    new Promise((resolve) => {
      const requestId = `my-${++nextId}`
      pending.set(requestId, resolve)
      socket.send(JSON.stringify({ kind: 'request', requestId, method, params }))
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          resolve({ kind: 'response', requestId, ok: false, error: { name: 'TimeoutError', message: '等待响应超时' } })
        }
      }, 5000)
    })

  const events: Array<{ type: string; payload: unknown }> = []
  let resolveTurn: (() => void) | undefined

  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as
      | ResponseMessage
      | { kind: 'event'; sessionId: string; event: { type: string; payload: unknown } }
    if (message.kind === 'response') {
      const resolve = pending.get(message.requestId)
      if (resolve) {
        pending.delete(message.requestId)
        resolve(message)
      }
    } else if (message.kind === 'event') {
      events.push({ type: message.event.type, payload: message.event.payload })
      if (message.event.type === 'turn/end') resolveTurn?.()
    }
  })

  const created = await request('session.create', { title: '脚本化客户端会话' })
  if (!created.ok || !created.result) throw new Error(`session.create 失败：${JSON.stringify(created.error)}`)
  const id = (created.result as { meta: { id: string } }).meta.id
  console.log(`已新建会话：${id}`)

  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve
  })
  const send = await request('session.send', { id, content: '你好' })
  if (!send.ok) throw new Error(`session.send 失败：${JSON.stringify(send.error)}`)
  await turnDone

  console.log('\n===== 收到的事件序列 =====')
  for (const event of events) {
    const raw = JSON.stringify(event.payload ?? '')
    const payload = event.type === 'assistant/stream' || event.type === 'user' ? raw : raw.slice(0, 60)
    console.log(`  ${event.type.padEnd(18)} ${payload}`)
  }

  const got = events.map((event) => event.type)
  console.log('\n===== 断言（红绿翻转：改 demo 台词本，这里就会红）=====')
  if (JSON.stringify(got) !== JSON.stringify(EXPECTED_TYPES)) {
    console.error('✗ 事件序列与预期不一致')
    console.error(`  期望：${EXPECTED_TYPES.join(' | ')}`)
    console.error(`  实际：${got.join(' | ')}`)
    socket.close()
    process.exit(1)
  }
  console.log('✓ 事件序列与预期一致：user → 工具往返 → 5 个流式分片 → assistant 全文 → turn/end')
  socket.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
