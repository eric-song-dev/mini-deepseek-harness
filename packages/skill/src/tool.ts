import type { Context } from 'cordis'
import type { Tool } from '@mini-dsh/tools'
import { UnknownSkillError } from './skills'
import type { SkillsService } from './skills'

/**
 * skill 工具（M5 spec 决策 5）："文档检索"，不是 prompt 拼接。
 *
 * 模型**按需**调用：action=list 列出技能名，action=get 取单个技能全文。
 * 不把全部 skill 塞进 system prompt（上下文成本 + 让模型自己决定何时需要）。
 * loop 一行不改：它只是 tools seam 里的一个普通工具。
 *
 * 语义（"输出是内容，异常是结果"——M3 工具语义）：
 * - 正常路径返回**内容**：{ skills } 列表 / { name, content } 全文；
 * - 模型侧的"异常"（未知技能、坏参数）返回 { error } **结果**——模型能看到
 *   失败原因并纠正（同 bash 的 exit code 是输出不是异常），而不是把整轮炸掉；
 *   seam 自身的 UnknownSkillError 在这里被转成结果，其他意外错误仍原样上抛。
 */

/** skill 工具的声明（模型可读的"我能干什么"）。 */
export const SKILL_TOOL_DECLARATION: Tool['declaration'] = {
  name: 'skill',
  description: '查询可用的技能（skill）。action=list 列出全部技能名；action=get 按 name 取技能全文。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get'],
        description: 'list=列出全部技能名；get=取单个技能全文',
      },
      name: {
        type: 'string',
        description: 'action=get 时必填的技能名',
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
        return { skills: skills.list() }
      }
      if (action === 'get') {
        const name = input.name
        if (typeof name !== 'string' || name === '') {
          return { error: 'action=get 需要 name 参数（先用 action=list 查看已注册技能名）' }
        }
        try {
          const skill = skills.get(name)
          return { name: skill.name, content: skill.content }
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
