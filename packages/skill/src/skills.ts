import 'cordis'
import type { Context } from 'cordis'

/**
 * Skills seam（M5）：agent 的"可检索知识"从哪来。
 *
 * 教学要点：这是本项目的第四个 seam（继 SessionPersistence、LLM、Tools 之后）。
 * 一个 skill = 名字 + SKILL.md 正文。消费方（skill 工具、未来的 UI）只认
 * 这套契约，不关心技能来自本地目录、远程市场还是 bundled——换来源 = 换提供
 * `skills` 服务的插件（M5 spec 决策 4）。
 */

/** 一个技能：名字 + 正文（SKILL.md 全文）。 */
export interface Skill {
  name: string
  content: string
}

/** Skills 抽象服务。 */
export interface SkillsService {
  /** 注册一个 skill；重名报错（防止静默覆盖）。 */
  register(skill: Skill): void
  /** 全部已注册技能名（保持注册顺序）。 */
  list(): string[]
  /** 按名取 skill；未知技能抛 UnknownSkillError（seam 对程序调用方是响亮的）。 */
  get(name: string): Skill
}

/** 取了一个未注册的 skill。 */
export class UnknownSkillError extends Error {
  readonly skill: string

  constructor(name: string) {
    super(`未知 skill：${name}`)
    this.name = 'UnknownSkillError'
    this.skill = name
  }
}

/** 默认 Skills seam 实现：内存注册表。 */
export function createSkillsRegistry(): SkillsService {
  const skills = new Map<string, Skill>()

  return {
    register(skill) {
      if (skills.has(skill.name)) {
        throw new Error(`skill 已注册：${skill.name}`)
      }
      skills.set(skill.name, skill)
    },
    list() {
      return [...skills.keys()]
    },
    get(name) {
      const skill = skills.get(name)
      if (!skill) throw new UnknownSkillError(name)
      return skill
    },
  }
}

/** 通用注入插件：把任意 SkillsService 实例注册成 `skills` 服务（测试/自定义来源用）。 */
export function provideSkills(ctx: Context, service: SkillsService): void {
  ctx.provide('skills', service)
}

// 服务类型增强：插件可通过 `ctx.skills` / `ctx.get('skills')` 取到 seam。
declare module 'cordis' {
  interface Context {
    skills: SkillsService
  }
}
