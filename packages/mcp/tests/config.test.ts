import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import type { McpConfig } from '../src/config'

/**
 * MCP 插件配置校验契约（T2）：mini 没有 schemastery，手写 resolveConfig——
 * 非法配置在装载时响亮报错（消息含字段名），合法配置补默认值。拒绝未知键
 * 是防拼写错误（如 server_name 打成 serverName 之外的拼法）的教学性决定。
 */

const MINIMAL = { serverName: 'fs', transport: 'stdio', command: 'node' }

describe('resolveConfig 校验 MCP 插件配置', () => {
  it('合法最小配置补默认值：args []、env {}、cwd 用传入的默认值', () => {
    const resolved = resolveConfig(MINIMAL, '/tmp/default-cwd')
    expect(resolved).toEqual({
      serverName: 'fs',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '/tmp/default-cwd',
    } satisfies McpConfig)
  })

  it('显式给出的 args/env/cwd 原样保留', () => {
    const resolved = resolveConfig({
      ...MINIMAL,
      args: ['-y', 'pkg'],
      env: { HOME: '/home/x' },
      cwd: '/work',
    })
    expect(resolved.args).toEqual(['-y', 'pkg'])
    expect(resolved.env).toEqual({ HOME: '/home/x' })
    expect(resolved.cwd).toBe('/work')
  })

  it('顶层不是对象（null/数组/字符串）时报错', () => {
    for (const bad of [null, [], 'stdio']) {
      expect(() => resolveConfig(bad)).toThrow(/配置必须是对象/)
    }
  })

  it('缺少 serverName 时报错且消息含 serverName', () => {
    expect(() => resolveConfig({ transport: 'stdio', command: 'node' }))
      .toThrow(/serverName.*必填/)
  })

  it('serverName 不匹配 ^[A-Za-z0-9_-]{1,32}$ 时报错', () => {
    for (const bad of ['', 'a b', 'a.b', 'a'.repeat(33), '中文']) {
      expect(() => resolveConfig({ ...MINIMAL, serverName: bad }))
        .toThrow(/serverName/)
    }
  })

  it('transport 缺失或不是 stdio 时报错（mini 只做 stdio）', () => {
    expect(() => resolveConfig({ serverName: 'fs', command: 'node' }))
      .toThrow(/transport/)
    expect(() => resolveConfig({ ...MINIMAL, transport: 'streamable-http' }))
      .toThrow(/只支持 stdio/)
  })

  it('command 缺失或为空字符串时报错', () => {
    expect(() => resolveConfig({ serverName: 'fs', transport: 'stdio' }))
      .toThrow(/command.*必填/)
    expect(() => resolveConfig({ ...MINIMAL, command: '' }))
      .toThrow(/command.*必填/)
  })

  it('args 不是字符串数组时报错', () => {
    expect(() => resolveConfig({ ...MINIMAL, args: '-y' }))
      .toThrow(/args/)
    expect(() => resolveConfig({ ...MINIMAL, args: [1] }))
      .toThrow(/args/)
  })

  it('env 的值不是字符串时报错', () => {
    expect(() => resolveConfig({ ...MINIMAL, env: 'HOME=/x' }))
      .toThrow(/env/)
    expect(() => resolveConfig({ ...MINIMAL, env: { PORT: 8080 } }))
      .toThrow(/env/)
  })

  it('cwd 不是字符串时报错', () => {
    expect(() => resolveConfig({ ...MINIMAL, cwd: 42 }))
      .toThrow(/cwd/)
  })

  it('未知字段报错（防拼写错误：server_name 之类不会静默被忽略）', () => {
    expect(() => resolveConfig({ ...MINIMAL, server_name: 'fs' }))
      .toThrow(/未知配置字段.*server_name/)
  })
})
