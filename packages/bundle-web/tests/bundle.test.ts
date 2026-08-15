import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { webBundle } from '@mini-dsh/bundle-web'
import type { ClientBridge } from '@mini-dsh/client'

describe('webBundle（M4：web profile 组合）', () => {
  it('装载后 clientShell 服务就绪，三个首批 UI 面板按序注册进各自 slot', async () => {
    const ctx = new Context()
    const bridge: ClientBridge = {
      request: async <T>() => undefined as T,
      onEvent: () => () => {},
      close: () => {},
    }
    try {
      await ctx.plugin(webBundle, { bridge })
      const registry = ctx.get('slot-registry')!
      expect([...registry.slots()].sort()).toEqual(['conversation', 'session-list', 'tool'])
      expect(ctx.get('client-session-store')).toBeDefined()
      expect(ctx.get('client-bridge')).toBe(bridge)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
