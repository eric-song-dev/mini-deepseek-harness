import { beforeEach, describe, expect, it } from 'vitest'
import { UnknownSkillError } from '@mini-dsh/skill'
import type { SkillsService } from '@mini-dsh/skill'

/**
 * Skills seam 的契约测试：任何实现（filesystem 发现、将来的远程市场/bundled）都必须全部通过。
 * 使用方式：`runSkillsContract({ make })`，每份实现提供自己的 harness。
 *
 * 契约主题（M5 spec 任务 2；M6 增撤销语义；M7 增 frontmatter 摘要字段与校验）：
 * - 注册表：register/list/get，list 保持注册顺序，get 取回完整内容；
 * - skill 必须带非空 description（目录只展示它，M7 起必填）；
 * - name 必须 kebab-case，否则 register 报错（M7 格式契约）；
 * - 调用策略 modelInvocable/userInvocable 可选，省略默认 true（M7 调用策略四象限）；
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
    it('register 后 list 返回全部技能名且保持注册顺序；get 取回完整内容（含 description 与规范化调用策略）', () => {
      skills.register({ name: 'tdd', description: 'TDD 纪律', content: '# TDD 纪律\n先写失败的测试。' })
      skills.register({ name: 'notes', description: 'notes 工作流', content: '# notes 工作流\n跨 session 记忆。' })
      expect(skills.list()).toEqual(['tdd', 'notes'])
      expect(skills.get('tdd')).toEqual({
        name: 'tdd',
        description: 'TDD 纪律',
        content: '# TDD 纪律\n先写失败的测试。',
        modelInvocable: true,
        userInvocable: true,
      })
      expect(skills.get('notes').description).toBe('notes 工作流')
    })

    it('调用策略字段省略时默认允许模型与用户调用（M7 四象限规范化）', () => {
      skills.register({ name: 'tdd', description: 'TDD 纪律', content: '正文' })
      expect(skills.get('tdd')).toMatchObject({ modelInvocable: true, userInvocable: true })
    })

    it('调用策略字段显式给出时原样保留（M7：modelInvocable: false 的 skill 只能被受信调用方取到）', () => {
      skills.register({
        name: 'translate',
        description: '人工触发的翻译流程',
        content: '正文',
        modelInvocable: false,
        userInvocable: true,
      })
      expect(skills.get('translate')).toMatchObject({ modelInvocable: false, userInvocable: true })
    })

    it('whenToUse 可选透传（get 取回）', () => {
      skills.register({
        name: 'code-review',
        description: '代码审查纪律',
        content: '正文',
        whenToUse: '审查 PR 时',
      })
      expect(skills.get('code-review').whenToUse).toBe('审查 PR 时')
    })

    it('非 kebab-case 的 name 注册报错（M7 格式契约）', () => {
      expect(() => skills.register({ name: 'Bad_Name', description: 'x', content: 'y' })).toThrow(/invalid skill name/)
      expect(() => skills.register({ name: '空格 名', description: 'x', content: 'y' })).toThrow(/invalid skill name/)
      expect(() => skills.register({ name: 'UPPER', description: 'x', content: 'y' })).toThrow(/invalid skill name/)
    })

    it('空 description 注册报错（目录只能展示它，缺失无法路由，M7 起必填）', () => {
      expect(() => skills.register({ name: 'tdd', description: '', content: 'y' })).toThrow(/description/)
    })

    it('调用策略字段非布尔注册报错（fail-closed：不把无效数据当默认放行）', () => {
      expect(() =>
        skills.register({ name: 'tdd', description: 'x', content: 'y', modelInvocable: 'yes' as unknown as boolean }),
      ).toThrow(/modelInvocable/)
    })

    it('重复注册同名 skill 报错（防止静默覆盖）', () => {
      skills.register({ name: 'tdd', description: 'x', content: '版本一' })
      expect(() => skills.register({ name: 'tdd', description: 'x', content: '版本二' })).toThrow(/已注册/)
      // 原注册内容不被覆盖
      expect(skills.get('tdd').content).toBe('版本一')
    })

    it('register 返回幂等撤销函数：撤销后 list/get 均不可见，重复撤销无害，同名可重注册（M6）', () => {
      const off = skills.register({ name: 'tdd', description: 'x', content: '# TDD 纪律' })
      expect(skills.list()).toEqual(['tdd'])
      off()
      expect(skills.list()).toEqual([])
      expect(() => skills.get('tdd')).toThrow(UnknownSkillError)
      expect(() => off()).not.toThrow()
      skills.register({ name: 'tdd', description: 'x', content: '# 新版' })
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
