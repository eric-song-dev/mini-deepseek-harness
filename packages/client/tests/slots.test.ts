import { describe, expect, it } from 'vitest'
import { createSlotRegistry } from '@mini-dsh/client'

describe('Slot 注册表（M4：UI 注册点，框架无关）', () => {
  it('注册后按 slot 名取回，同 slot 多值不适用（每 slot 唯一注册者）', () => {
    const registry = createSlotRegistry()
    const panelA = { render: 'A' }
    registry.register('session-list', panelA)
    expect(registry.get('session-list')).toEqual([panelA])
    expect(registry.slots()).toEqual(['session-list'])
  })

  it('同一 slot 重复注册抛错（静态注册点：防止两个插件悄悄互相覆盖）', () => {
    const registry = createSlotRegistry()
    registry.register('conversation', { render: '甲' })
    expect(() => registry.register('conversation', { render: '乙' })).toThrow(/conversation/)
  })

  it('未注册的 slot get 返回空数组', () => {
    const registry = createSlotRegistry()
    expect(registry.get('tool')).toEqual([])
    expect(registry.slots()).toEqual([])
  })

  it('注册表不依赖任何 UI 框架（值是框架不透明句柄，框架只是第一个渲染实现）', () => {
    const registry = createSlotRegistry()
    // 任何值都能注册：React 组件、字符串、函数——注册表不关心
    registry.register('conversation', '一段描述')
    registry.register('session-list', 42)
    expect(registry.get('conversation')).toEqual(['一段描述'])
    expect(registry.get('session-list')).toEqual([42])
  })

  it('register 返回幂等撤销函数：撤销后 get 空、slots 不含该名，同名可重注册（M6）', () => {
    const registry = createSlotRegistry()
    const off = registry.register('session-list', { render: 'A' })
    expect(registry.get('session-list')).toEqual([{ render: 'A' }])
    off()
    off()
    expect(registry.get('session-list')).toEqual([])
    expect(registry.slots()).toEqual([])
    registry.register('session-list', { render: 'B' })
    expect(registry.get('session-list')).toEqual([{ render: 'B' }])
  })
})
