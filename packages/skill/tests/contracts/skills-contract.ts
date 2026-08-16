import { beforeEach, describe, expect, it } from 'vitest'
import { UnknownSkillError } from '@mini-dsh/skill'
import type { SkillsService } from '@mini-dsh/skill'

/**
 * Skills seam 的契约测试：任何实现（filesystem 发现、将来的远程市场/bundled）都必须全部通过。
 * 使用方式：`runSkillsContract({ make })`，每份实现提供自己的 harness。
 *
 * 契约主题（M5 spec 任务 2；M6 增撤销语义）：
 * - 注册表：register/list/get，list 保持注册顺序，get 取回完整内容；
 * - 未知 skill 报错（UnknownSkillError 带技能名——seam 对程序调用方是响亮的）；
 * - 重复注册报错（防止静默覆盖）；
 * - register 返回幂等撤销函数（M6 注册可逆：撤销后不可见、同名可重注册）。
 */
export interface SkillsContractHarness {
  /** 每个用例创建一个空实现。 */
  make: () => SkillsService
}

export function runSkillsContract(harness: SkillsContractHarness): void {
  let skills: SkillsService
  beforeEach(() => {
    skills = harness.make()
  })

  describe('Skills seam 契约（任何实现都必须通过）', () => {
    it('register 后 list 返回全部技能名且保持注册顺序；get 取回完整内容', () => {
      skills.register({ name: 'tdd', content: '# TDD 纪律\n先写失败的测试。' })
      skills.register({ name: 'notes', content: '# notes 工作流\n跨 session 记忆。' })
      expect(skills.list()).toEqual(['tdd', 'notes'])
      expect(skills.get('tdd')).toEqual({ name: 'tdd', content: '# TDD 纪律\n先写失败的测试。' })
      expect(skills.get('notes')).toEqual({ name: 'notes', content: '# notes 工作流\n跨 session 记忆。' })
    })

    it('重复注册同名 skill 报错（防止静默覆盖）', () => {
      skills.register({ name: 'tdd', content: '版本一' })
      expect(() => skills.register({ name: 'tdd', content: '版本二' })).toThrow(/已注册/)
      // 原注册内容不被覆盖
      expect(skills.get('tdd').content).toBe('版本一')
    })

    it('register 返回幂等撤销函数：撤销后 list/get 均不可见，重复撤销无害，同名可重注册（M6）', () => {
      const off = skills.register({ name: 'tdd', content: '# TDD 纪律' })
      expect(skills.list()).toEqual(['tdd'])
      off()
      expect(skills.list()).toEqual([])
      expect(() => skills.get('tdd')).toThrow(UnknownSkillError)
      expect(() => off()).not.toThrow()
      skills.register({ name: 'tdd', content: '# 新版' })
      expect(skills.get('tdd').content).toBe('# 新版')
    })

    it('get 未知 skill 抛 UnknownSkillError（带技能名，程序调用方能拿到失败原因）', () => {
      expect(() => skills.get('nope')).toThrow(UnknownSkillError)
      expect(() => skills.get('nope')).toThrow(/nope/)
      try {
        skills.get('nope')
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownSkillError)
        expect((error as UnknownSkillError).skill).toBe('nope')
      }
    })

    it('list 为空的注册表返回空数组（没有 skill 的系统也能跑）', () => {
      expect(skills.list()).toEqual([])
    })
  })
}
