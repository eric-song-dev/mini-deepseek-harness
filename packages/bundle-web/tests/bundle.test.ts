import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { webBundle } from '@mini-dsh/bundle-web'
import type { ClientBridge } from '@mini-dsh/client'

describe('webBundle（M4：web profile 组合）', () => {
  it('装载后 clientShell 服务就绪，UI 面板按序注册进各自 slot（M5：含 trajectory）', async () => {
    const ctx = new Context()
    const bridge: ClientBridge = {
      request: async <T>() => undefined as T,
      onEvent: () => () => {},
      close: () => {},
    }
    try {
      await ctx.plugin(webBundle, { bridge })
      const registry = ctx.get('slot-registry')!
      // M5：加 ui-trajectory = 这里多一个 slot 名，shell 与 entry 不改
      expect([...registry.slots()].sort()).toEqual(['conversation', 'session-list', 'tool', 'trajectory'])
      expect(ctx.get('client-session-store')).toBeDefined()
      expect(ctx.get('client-bridge')).toBe(bridge)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
