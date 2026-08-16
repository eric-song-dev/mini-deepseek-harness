import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { memoryConnectionPair } from '@mini-dsh/web'
import { clientShell, createBridgeClient } from '@mini-dsh/client'

/**
 * HMR-safety 测试组（M6 决策 6）：clientShell 是装配者（M4 决策），订阅链
 * （store → bridge → transport）的清理归它。M6 之前 shell 卸载后 store 的
 * onEvent 订阅仍挂在桥上、WebSocket 保持连接——真实泄漏。
 */
describe('注册可逆（M6）：clientShell 卸载即闭环订阅链', () => {
  it('fiber dispose 后 bridge 关闭（对侧收到 close）、store 已退订、新请求立即 reject', async () => {
    const { ctx, dispose } = await createTestContext()
    const [hostSide, clientSide] = memoryConnectionPair()
    let hostClosed = false
    hostSide.onClose(() => {
      hostClosed = true
    })
    const bridge = createBridgeClient(clientSide)
    const fiber = await ctx.plugin(clientShell, { bridge })
    expect(hostClosed).toBe(false)

    await fiber.dispose()

    expect(hostClosed).toBe(true)
    await expect(bridge.request('session.list')).rejects.toMatchObject({ name: 'ConnectionClosedError' })
    await dispose()
  })
})
