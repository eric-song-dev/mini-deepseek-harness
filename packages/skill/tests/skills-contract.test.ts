import { describe } from 'vitest'
import { createSkillsRegistry } from '@mini-dsh/skill'
import { runSkillsContract } from './contracts/skills-contract'

/** 默认注册表实现跑契约套件（filesystem 发现后端同款模式：实现换一套，契约一份）。 */
describe('createSkillsRegistry（默认 Skills seam 实现）', () => {
  runSkillsContract({ make: () => createSkillsRegistry() })
})
