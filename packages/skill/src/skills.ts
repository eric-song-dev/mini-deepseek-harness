import 'cordis'
import type { Context } from 'cordis'

/**
 * Skills seam（M5）：agent 的"可检索知识"从哪来。
 *
 * 教学要点：这是本项目的第四个 seam（继 SessionPersistence、LLM、Tools 之后）。
 * 一个 skill = 名字 + description + SKILL.md 正文。消费方（skill 工具、未来的 UI）
 * 只认这套契约，不关心技能来自本地目录、远程市场还是 bundled——换来源 = 换提供
 * `skills` 服务的插件（M5 spec 决策 4）。
 *
 * M7 起（原版格式约定）：description 必填（目录/列表**只展示它**，正文与路径从不进
 * 目录）；调用策略 modelInvocable/userInvocable 可选、省略默认 true（上游调用策略
 * 四象限的规范化——register 后 get 恒返回两个布尔）；name 必须 kebab-case。
 */

/** kebab-case：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（上游 SKILL_NAME 同款）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 判断一个名字是否是合法 skill 名（kebab-case）。 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** 一个技能：名字 + 目录摘要（description）+ 正文（frontmatter 剥离后的 SKILL.md 全文）。 */
export interface Skill {
  /** kebab-case 标识（与目录名/文件名一致，fs-discovery 校验）。 */
  name: string
  /** 路由摘要：目录/列表只展示它（上游 SkillSummary 的同名字段）。 */
  description: string
  /** SKILL.md 正文（frontmatter 之后的全文）。 */
  content: string
  /** 可选的路由补充提示（上游 whenToUse）。 */
  whenToUse?: string
  /**
   * 模型可否经 skill 工具加载（`disable-model-invocation` 的反向规范化）。
   * 省略默认 true；register 后 get 恒返回布尔。
   */
  modelInvocable?: boolean
  /** 用户界面（slash 菜单等）可否加载；省略默认 true。 */
  userInvocable?: boolean
}

/** 撤销函数：调用后撤销本次注册；幂等（重复调用无害）。 */
export type Unregister = () => void

/** Skills 抽象服务。 */
export interface SkillsService {
  /**
   * 注册一个 skill；重名报错（防止静默覆盖）。
   * 返回幂等撤销函数（M6 注册可逆）：调用后 list/get 均不可见，同名可重注册。
   * 注册方插件用 `ctx.effect(() => () => off())` 挂接，卸载即撤销。
   */
  register(skill: Skill): Unregister
  /** 全部已注册技能名（保持注册顺序）。 */
  list(): string[]
  /**
   * 按名取 skill；未知技能抛 UnknownSkillError（seam 对程序调用方是响亮的）。
   * 受信原语（M7 消费方边界纪律）：不做 modelInvocable 过滤，过滤归消费方（skill 工具）。
   */
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

/** 注册入参违反 skill 格式契约（kebab name / 非空 description / 布尔调用策略）。 */
export class InvalidSkillError extends Error {}

/** 校验一个 skill 入参；违反契约抛 InvalidSkillError（fail-closed：坏数据不进注册表）。 */
function validateSkill(skill: Skill): void {
  if (!isSkillName(skill.name)) throw new InvalidSkillError(`invalid skill name "${skill.name}"`)
  if (typeof skill.description !== 'string' || skill.description.length === 0) {
    throw new InvalidSkillError(`skill "${skill.name}" requires a description`)
  }
  if (skill.whenToUse !== undefined && typeof skill.whenToUse !== 'string') {
    throw new InvalidSkillError(`skill "${skill.name}" whenToUse must be a string`)
  }
  if (skill.modelInvocable !== undefined && typeof skill.modelInvocable !== 'boolean') {
    throw new InvalidSkillError(`skill "${skill.name}" modelInvocable must be a boolean`)
  }
  if (skill.userInvocable !== undefined && typeof skill.userInvocable !== 'boolean') {
    throw new InvalidSkillError(`skill "${skill.name}" userInvocable must be a boolean`)
  }
}

/** 规范化一个 skill：调用策略省略时补默认（上游"一次性补全默认值"的 mini 版）。 */
function normalizeSkill(skill: Skill): Skill {
  return {
    ...skill,
    modelInvocable: skill.modelInvocable ?? true,
    userInvocable: skill.userInvocable ?? true,
  }
}

/** 默认 Skills seam 实现：内存注册表。 */
export function createSkillsRegistry(): SkillsService {
  const skills = new Map<string, Skill>()

  return {
    register(skill) {
      validateSkill(skill)
      if (skills.has(skill.name)) {
        throw new Error(`skill 已注册：${skill.name}`)
      }
      const stored = normalizeSkill(skill)
      skills.set(stored.name, stored)
      let active = true
      return () => {
        // 幂等：只撤销"我注册的那一个"——若已被同名重注册，不误删新 skill
        if (active && skills.get(stored.name) === stored) skills.delete(stored.name)
        active = false
      }
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
