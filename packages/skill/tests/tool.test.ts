import { describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { createToolRegistry, provideTools } from '@mini-dsh/tools'
import { createSkillsRegistry, createSkillTool, provideSkills, skillTool } from '@mini-dsh/skill'
import type { SkillsService } from '@mini-dsh/skill'

/**
 * skill 工具（M5：模型按需检索技能；M7 升级为目录展示）：
 * - list → { skills: [{ name, description }] }——只含 modelInvocable 技能、
 *   description 规范化（空白折叠）并截断 500（上游 catalogDescription）；
 * - get → { name, description, content } 技能全文（frontmatter 已剥离）；
 * - 消费方边界纪律（上游"get 是受信原语"）：modelInvocable: false 的技能
 *   模型不可加载，get 返回 { error } 结果；
 * - 语义（M5 spec 决策 5 + M3 工具语义"输出是内容，异常是结果"）：
 *   正常路径返回内容；模型侧异常（未知技能、坏参数、不可调用）返回 { error }
 *   结果——模型能看到失败原因并纠正，而不是把整轮炸掉。
 */
describe('skill 工具（M7：目录展示 + 调用策略过滤）', () => {
  function makeSkills(): SkillsService {
    const skills = createSkillsRegistry()
    skills.register({ name: 'tdd', description: '测试驱动开发纪律：先写失败的测试。', content: '# TDD 纪律\n先写失败的测试。' })
    skills.register({ name: 'notes', description: '跨 session 记忆工作流', content: '# notes 工作流' })
    skills.register({
      name: 'translate',
      description: '人工触发的双语翻译流程',
      content: '# 翻译流程',
      modelInvocable: false,
      userInvocable: true,
    })
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

  it('action=list → { skills: [{name, description}] }，保持注册顺序，只含 modelInvocable 技能', async () => {
    const tool = createSkillTool(makeSkills())
    expect(await tool.execute({ action: 'list' }, { cwd: '/' })).toEqual({
      skills: [
        { name: 'tdd', description: '测试驱动开发纪律：先写失败的测试。' },
        { name: 'notes', description: '跨 session 记忆工作流' },
      ],
    })
  })

  it('action=list：description 空白折叠并截断 500（超长补 …）', async () => {
    const skills = createSkillsRegistry()
    skills.register({ name: 'long', description: `多 段  空白${'很'.repeat(600)}`, content: 'x' })
    const tool = createSkillTool(skills)
    const output = (await tool.execute({ action: 'list' }, { cwd: '/' })) as { skills: Array<{ description: string }> }
    const description = output.skills[0]!.description
    expect(description).not.toMatch(/\s{2,}/)
    expect(description.startsWith('多 段 空白')).toBe(true)
    expect(description).toHaveLength(500)
    expect(description.endsWith('...')).toBe(true)
  })

  it('action=get → { name, description, content } 技能全文', async () => {
    const tool = createSkillTool(makeSkills())
    expect(await tool.execute({ action: 'get', name: 'tdd' }, { cwd: '/' })).toEqual({
      name: 'tdd',
      description: '测试驱动开发纪律：先写失败的测试。',
      content: '# TDD 纪律\n先写失败的测试。',
    })
  })

  it('action=get：modelInvocable:false 的技能模型不可加载 → { error } 结果（消费方边界纪律）', async () => {
    const tool = createSkillTool(makeSkills())
    const output = await tool.execute({ action: 'get', name: 'translate' }, { cwd: '/' })
    expect(output).toEqual({ error: expect.stringContaining('not available for model invocation') })
    expect(output).toMatchObject({ error: expect.stringContaining('translate') })
  })

  it('action=get：非 kebab 名 → { error } 结果（先校验名字形态，再查表）', async () => {
    const tool = createSkillTool(makeSkills())
    const output = await tool.execute({ action: 'get', name: 'Bad Name' }, { cwd: '/' })
    expect(output).toMatchObject({ error: expect.stringContaining('invalid skill name') })
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
        description: '跨 session 记忆工作流',
        content: '# notes 工作流',
      })
    } finally {
      await dispose()
    }
  })
})
