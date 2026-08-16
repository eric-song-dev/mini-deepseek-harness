import { describe, expect, it } from 'vitest'
import { publicToolName } from '../src/tools'

/**
 * 公开工具名契约（T3）：publicToolName 是 (serverName, rawName) 的纯函数——
 * 干净名字 = `mcp__<server>__<raw>` 原样；非法字符替换为 `_`；
 * 超长（>64）报错（mini 裁剪：不截断不加 hash，见 M9 spec 决策 1）。
 * 调用方保证 serverName 已过 config 校验（^[A-Za-z0-9_-]{1,32}$），
 * 但函数本身不假设 rawName 合法——rawName 来自不可信的外部 server。
 */

describe('publicToolName 生成模型可见工具名', () => {
  it('干净名字 = mcp__<server>__<raw> 原样拼接', () => {
    expect(publicToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file')
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })

  it('rawName 里的非法字符替换为下划线', () => {
    expect(publicToolName('fixture', 'admin.reset')).toBe('mcp__fixture__admin_reset')
    expect(publicToolName('web', 'get weather')).toBe('mcp__web__get_weather')
  })

  it('是纯函数：同样输入永远同样输出（与连接顺序、其他 server 无关）', () => {
    expect(publicToolName('fs', 'read')).toBe(publicToolName('fs', 'read'))
  })

  it('不同 server 的相同 rawName 在各自治命名空间下共存', () => {
    expect(publicToolName('a', 'search')).not.toBe(publicToolName('b', 'search'))
  })

  it('公开名超过 64 字符时报错（不静默截断——mini 裁剪决定）', () => {
    expect(() => publicToolName('srv', 't'.repeat(80))).toThrow(/超过 64/)
  })

  it('mcp__ 前缀把 MCP 注册与原生工具命名空间隔离', () => {
    expect(publicToolName('fs', 'bash')).toBe('mcp__fs__bash')
    expect(publicToolName('fs', 'bash')).not.toBe('bash')
  })
})
