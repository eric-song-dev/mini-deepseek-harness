import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { createToolRegistry, provideTools } from '@mini-dsh/tools'
import { createSkillsRegistry, createSkillTool, provideSkills, skillTool } from '@mini-dsh/skill'
import type { SkillsService } from '@mini-dsh/skill'

/**
 * skill 工具（M5）：模型按需检索技能的"文档检索"工具。
 * 语义（M5 spec 决策 5 + M3 工具语义"输出是内容，异常是结果"）：
 * - list → { skills } 技能名列表；get → { name, content } 技能全文——这是"内容"；
 * - 未知技能 / 坏参数 → { error } 作为结果返回（模型能看到失败原因并纠正，
 *   而不是把整轮炸掉）——这是"异常是结果"。
 */
describe('skill 工具（M5：模型按需取技能）', () => {
  function makeSkills(): SkillsService {
    const skills = createSkillsRegistry()
    skills.register({ name: 'tdd', content: '# TDD 纪律\n先写失败的测试。' })
    skills.register({ name: 'notes', content: '# notes 工作流' })
    return skills
  }

  it('声明：name=skill，action 只能 list/get，name 参数仅 get 使用', () => {
    const declaration = createSkillTool(makeSkills()).declaration
    expect(declaration.name).toBe('skill')
    expect(declaration.description).toContain('技能')
    expect(declaration.parameters).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: expect.stringContaining('list') },
        name: { type: 'string', description: expect.stringContaining('get') },
      },
      required: ['action'],
    })
  })

  it('action=list → { skills: 已注册技能名 }（按注册顺序）', async () => {
    const tool = createSkillTool(makeSkills())
    expect(await tool.execute({ action: 'list' }, { cwd: '/' })).toEqual({ skills: ['tdd', 'notes'] })
  })

  it('action=get → { name, content } 技能全文', async () => {
    const tool = createSkillTool(makeSkills())
    expect(await tool.execute({ action: 'get', name: 'tdd' }, { cwd: '/' })).toEqual({
      name: 'tdd',
      content: '# TDD 纪律\n先写失败的测试。',
    })
  })

  it('action=get 未知技能 → { error } 结果（异常是结果：模型能看到失败原因，不炸轮）', async () => {
    const tool = createSkillTool(makeSkills())
    const output = await tool.execute({ action: 'get', name: 'nope' }, { cwd: '/' })
    expect(output).toMatchObject({ error: expect.stringContaining('nope') })
  })

  it('action=get 缺 name → { error } 结果', async () => {
    const tool = createSkillTool(makeSkills())
    const output = await tool.execute({ action: 'get' }, { cwd: '/' })
    expect(output).toMatchObject({ error: expect.stringContaining('name') })
  })

  it('未知 action → { error } 结果（提示可用 action）', async () => {
    const tool = createSkillTool(makeSkills())
    const output = await tool.execute({ action: 'remove', name: 'tdd' }, { cwd: '/' })
    expect(output).toMatchObject({ error: expect.stringContaining('remove') })
  })

  it('skillTool 插件（inject skills+tools）：注册进 tools 注册表，execute 走注入的 seam', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(provideTools, createToolRegistry())
      await ctx.plugin(provideSkills, makeSkills())
      await ctx.plugin(skillTool)
      const tool = ctx.get('tools')!.get('skill')
      expect(tool).toBeDefined()
      expect(ctx.get('tools')!.list().map((d) => d.name)).toEqual(['skill'])
      expect(await tool!.execute({ action: 'get', name: 'notes' }, { cwd: '/' })).toEqual({
        name: 'notes',
        content: '# notes 工作流',
      })
    } finally {
      await dispose()
    }
  })
})
