import { describe, expect, it } from 'vitest'
import { createRpcBridge, memoryConnectionPair } from '@mini-dsh/web'

/**
 * M6 教程练习 2：my-rpc-off —— RPC 方法的注册与撤销。
 *
 * 红绿翻转（跟着教程做）：
 * 1. 先把第 30 行的期望改成"撤销后仍能调用成功"（ok: true），跑测试 → 红；
 * 2. 再改回"撤销后得到 UnknownMethodError" → 绿。
 * 红的原因：M6 起 handle 返回幂等撤销函数，撤销后方法真的消失。
 */
describe('M6 练习 2：RPC 方法可撤销', () => {
  it('撤销 handler 后请求得到 UnknownMethodError', async () => {
    const bridge = createRpcBridge()
    const [hostSide, clientSide] = memoryConnectionPair()
    bridge.accept(hostSide)
    const off = bridge.handle('greet', () => '你好')

    const received: Array<{ ok?: boolean; error?: { name?: string } }> = []
    clientSide.onMessage((message) => {
      received.push(message as { ok?: boolean; error?: { name?: string } })
    })
    const waitFor = async (): Promise<void> => {
      const deadline = Date.now() + 1000
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }

    clientSide.send({ kind: 'request', requestId: 'r-1', method: 'greet' })
    await waitFor()
    expect(received.shift()).toMatchObject({ ok: true, result: '你好' })

    off() // ← M6 的撤销函数
    clientSide.send({ kind: 'request', requestId: 'r-2', method: 'greet' })
    await waitFor()
    expect(received.shift()).toMatchObject({ ok: false, error: { name: 'UnknownMethodError' } })
  })
})
