import type { Context } from 'cordis'
import type { Tool } from '@mini-dsh/tools'
import { isSkillName, UnknownSkillError } from './skills'
import type { SkillsService } from './skills'

/**
 * skill 工具（M5 spec 决策 5："文档检索"，不是 prompt 拼接；M7 升级为目录展示）。
 *
 * 模型**按需**调用：action=list 列出可加载技能的 {name, description} 目录，
 * action=get 取单个技能全文。不把全部 skill 塞进 system prompt（上下文成本 +
 * 让模型自己决定何时需要）。loop 一行不改：它只是 tools seam 里的一个普通工具。
 *
 * M7 目录契约（上游 tool-skill 的消费方边界纪律）：
 * - list 只含 modelInvocable 技能，description 规范化（空白折叠）并截断 500
 *   （上游 catalogDescription 同款）；正文/路径/whenToUse 不进目录；
 * - get 先校验 kebab 名 → 查表 → 再验 modelInvocable（false → 不可加载）；
 *   `SkillsService.get` 是受信原语，过滤在这里做。
 *
 * 语义（"输出是内容，异常是结果"——M3 工具语义）：
 * - 正常路径返回**内容**：{ skills } 目录 / { name, description, content } 全文；
 * - 模型侧的"异常"（未知技能、坏参数、不可调用）返回 { error } **结果**——
 *   模型能看到失败原因并纠正（同 bash 的 exit code 是输出不是异常），而不是把
 *   整轮炸掉；seam 自身的 UnknownSkillError 在这里被转成结果，其他意外错误仍上抛。
 */

/** 目录描述上限（上游 catalogDescriptionMaxLength 默认值）。 */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500

/**
 * 规范化目录描述：空白折叠（连续空白 → 单空格 + trim），超长截断补 …。
 * 上游 catalogDescription 同款（截断到 max-3 再补三个点，总长恰为 max）。
 */
export function catalogDescription(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= CATALOG_DESCRIPTION_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`
}

/** skill 工具的声明（模型可读的"我能干什么"）。 */
export const SKILL_TOOL_DECLARATION: Tool['declaration'] = {
  name: 'skill',
  description: '查询可用的技能（skill）。action=list 列出全部可加载技能名与描述；action=get 按 name 取技能全文。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get'],
        description: 'list=列出全部可加载技能（名 + 描述）；get=取单个技能全文',
      },
      name: {
        type: 'string',
        description: 'action=get 时必填的技能名（先 action=list 查看）',
      },
    },
    required: ['action'],
  },
}

/** 造一个 skill 工具（execute 闭包持有注入的 Skills seam）。 */
export function createSkillTool(skills: SkillsService): Tool {
  return {
    declaration: SKILL_TOOL_DECLARATION,
    execute(input: Record<string, unknown>) {
      const action = input.action
      if (action === 'list') {
        // 模型目录：只含 modelInvocable 技能，只展示 name + description（截断 500）
        const entries = skills
          .list()
          .map((name) => skills.get(name))
          .filter((skill) => skill.modelInvocable !== false)
          .map((skill) => ({ name: skill.name, description: catalogDescription(skill.description) }))
        return { skills: entries }
      }
      if (action === 'get') {
        const name = input.name
        if (typeof name !== 'string' || name === '') {
          return { error: 'action=get 需要 name 参数（先用 action=list 查看已注册技能名）' }
        }
        if (!isSkillName(name)) {
          return { error: `invalid skill name "${name}"（技能名是 kebab-case，如 code-review）` }
        }
        try {
          const skill = skills.get(name)
          // 消费方边界纪律：get 是受信原语，模型可否加载在这里判定
          if (skill.modelInvocable === false) {
            return { error: `skill "${name}" is not available for model invocation（此技能仅供用户显式触发）` }
          }
          return { name: skill.name, description: skill.description, content: skill.content }
        } catch (error) {
          if (error instanceof UnknownSkillError) {
            return { error: `未知 skill：${error.skill}（用 action=list 查看已注册技能）` }
          }
          throw error
        }
      }
      return { error: `未知 action：${String(action)}（可用：list / get）` }
    },
  }
}

/**
 * 插件：把 skill 工具注册进 tools seam（inject skills + tools）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销注册。
 */
export const skillTool = Object.assign(
  function skillTool(ctx: Context): void {
    const off = ctx.tools.register(createSkillTool(ctx.skills))
    ctx.effect(() => () => off())
  },
  { inject: ['skills', 'tools'] },
)
