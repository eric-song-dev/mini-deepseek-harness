import { beforeEach, describe, expect, it } from 'vitest'
import { ToolDeniedError, UnknownToolError } from '@mini-dsh/tools'
import type { Tool, ToolContext, ToolsService } from '@mini-dsh/tools'

/**
 * Tools seam 的契约测试：任何实现（默认注册表、将来的 MCP 注册表等）都必须全部通过。
 * 使用方式：`runToolsContract({ make })`，每份实现提供自己的 harness。
 *
 * 契约主题（M3 spec 任务 2）：
 * - 注册表：注册/查找/声明列表（保序）；
 * - 未知工具报错、重名注册报错；
 * - 执行管线：pre-execute hooks（approval hook 预留位）→ execute → post-execute（结果整形）；
 * - 错误路径：拒绝与工具自身错误都原样传播，不吞错。
 */
export interface ToolsContractHarness {
  /** 每个用例创建一个空实现。 */
  make: () => ToolsService
}

export const testCtx: ToolContext = { cwd: '/work' }

/** 造一个回显工具：execute 原样返回 input（声明/实现都可定制）。 */
export function echoTool(
  name: string,
  overrides: Partial<Tool> = {},
): Tool {
  return {
    declaration: { name, description: `回显工具 ${name}`, parameters: { type: 'object' } },
    execute: async (input: Record<string, unknown>) => input,
    ...overrides,
  }
}

export function runToolsContract(harness: ToolsContractHarness): void {
  let tools: ToolsService
  beforeEach(() => {
    tools = harness.make()
  })

  describe('Tools seam 契约（任何实现都必须通过）', () => {
    it('register 后 get 可查、list 返回声明且保持注册顺序', () => {
      tools.register(echoTool('a'))
      tools.register(echoTool('b'))
      expect(tools.get('a')?.declaration).toEqual({ name: 'a', description: '回显工具 a', parameters: { type: 'object' } })
      expect(tools.get('nope')).toBeUndefined()
      expect(tools.list().map((d) => d.name)).toEqual(['a', 'b'])
    })

    it('重复注册同名工具报错（防止静默覆盖）', () => {
      tools.register(echoTool('a'))
      expect(() => tools.register(echoTool('a'))).toThrow(/已注册/)
    })

    it('execute 未知工具抛 UnknownToolError（带工具名）', async () => {
      await expect(tools.execute('nope', {}, testCtx)).rejects.toBeInstanceOf(UnknownToolError)
      await expect(tools.execute('nope', {}, testCtx)).rejects.toMatchObject({ name: 'UnknownToolError' })
      await expect(tools.execute('nope', {}, testCtx)).rejects.toThrow(/nope/)
    })

    it('execute 把 input 与 ctx 原样交给工具实现，返回其输出', async () => {
      const seen: Array<{ input: Record<string, unknown>; ctx: ToolContext }> = []
      tools.register({
        declaration: { name: 'probe', description: '探针', parameters: { type: 'object' } },
        execute: async (input, ctx) => {
          seen.push({ input, ctx })
          return 'ok'
        },
      })
      const output = await tools.execute('probe', { path: 'a.txt' }, testCtx)
      expect(output).toBe('ok')
      expect(seen).toEqual([{ input: { path: 'a.txt' }, ctx: testCtx }])
    })

    it('管线顺序：pre-execute hooks → execute → post-execute hooks，各阶段内部按注册顺序', async () => {
      const order: string[] = []
      tools.register({
        declaration: { name: 't', description: '', parameters: {} },
        execute: async () => {
          order.push('execute')
          return 'raw'
        },
      })
      tools.addHook('pre-execute', async () => {
        order.push('pre-1')
      })
      tools.addHook('pre-execute', async () => {
        order.push('pre-2')
      })
      tools.addHook('post-execute', async () => {
        order.push('post-1')
      })
      tools.addHook('post-execute', async () => {
        order.push('post-2')
      })
      await tools.execute('t', {}, testCtx)
      expect(order).toEqual(['pre-1', 'pre-2', 'execute', 'post-1', 'post-2'])
    })

    it('pre-execute hook 拒绝（抛 ToolDeniedError）时工具不执行、rejection 原样传播', async () => {
      let executed = false
      tools.register({
        declaration: { name: 't', description: '', parameters: {} },
        execute: async () => {
          executed = true
          return 'ok'
        },
      })
      tools.addHook('pre-execute', () => {
        throw new ToolDeniedError('t', '教学演示：这里拒绝')
      })
      await expect(tools.execute('t', {}, testCtx)).rejects.toBeInstanceOf(ToolDeniedError)
      expect(executed).toBe(false)
    })

    it('post-execute hook 的返回值替换输出（结果整形）；返回 undefined 表示不改', async () => {
      tools.register({
        declaration: { name: 't', description: '', parameters: {} },
        execute: async () => ({ stdout: 'hi' }),
      })
      tools.addHook('post-execute', () => undefined)
      tools.addHook('post-execute', (_invocation, output) => ({ wrapped: output }))
      await expect(tools.execute('t', {}, testCtx)).resolves.toEqual({ wrapped: { stdout: 'hi' } })
    })

    it('工具实现抛错原样传播（管线不吞错）', async () => {
      tools.register({
        declaration: { name: 'boom', description: '', parameters: {} },
        execute: async () => {
          throw new Error('工具内部炸了')
        },
      })
      await expect(tools.execute('boom', {}, testCtx)).rejects.toThrow('工具内部炸了')
    })
  })
}
