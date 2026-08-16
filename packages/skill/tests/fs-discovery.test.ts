import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSkills } from '@mini-dsh/skill'

/**
 * filesystem 发现（M5 建立；M7 升级为 frontmatter 契约）：
 * 目录约定 `<dir>/<name>/SKILL.md`——目录名即 skill 名；SKILL.md 带 YAML
 * frontmatter（name 必须与目录名一致、description 必填），content 只返回
 * frontmatter 之后的正文。边界行为契约：
 * - 目录不存在 → 空数组（graceful：没装 skill 的系统照常启动）；
 * - 路径是文件（坏目录）→ 报错（响亮地暴露配置错误）；
 * - 非目录项与没有 SKILL.md 的子目录跳过；
 * - 坏 frontmatter / name 与目录名不符 / 驼峰 legacy 键 → 抛 InvalidSkillError
 *   （fail-closed：坏条目响亮失败，绝不默认放行——M7 决策 2）。
 */

/** 造一个合法 SKILL.md 全文（name 与目录名一致 + description）。 */
function skillFile(name: string, description: string, body = '# 正文\n', extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}${extra ? '\n' + extra : ''}\n---\n${body}`
}

describe('discoverSkills（filesystem 发现后端，M7 frontmatter 契约）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mini-dsh-skills-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('扫描目录：name 即目录名，description/content 来自 frontmatter（frontmatter 已剥离），按名排序', async () => {
    await mkdir(join(dir, 'tdd'))
    await mkdir(join(dir, 'notes'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), skillFile('tdd', '测试驱动开发纪律', '# TDD\n先测试。'), 'utf8')
    await writeFile(join(dir, 'notes', 'SKILL.md'), skillFile('notes', '跨 session 记忆', '# notes\n记忆。'), 'utf8')

    expect(await discoverSkills(dir)).toEqual([
      {
        name: 'notes',
        description: '跨 session 记忆',
        content: '# notes\n记忆。',
        modelInvocable: true,
        userInvocable: true,
      },
      {
        name: 'tdd',
        description: '测试驱动开发纪律',
        content: '# TDD\n先测试。',
        modelInvocable: true,
        userInvocable: true,
      },
    ])
  })

  it('调用控制字段透传：disable-model-invocation → modelInvocable:false（四象限规范化的发现侧）', async () => {
    await mkdir(join(dir, 'translate'))
    await writeFile(
      join(dir, 'translate', 'SKILL.md'),
      skillFile('translate', '人工翻译流程', '正文', 'disable-model-invocation: true\nuser-invocable: false'),
      'utf8',
    )
    const [skill] = await discoverSkills(dir)
    expect(skill).toMatchObject({ name: 'translate', modelInvocable: false, userInvocable: false })
  })

  it('目录不存在 → 空数组（graceful：没有 skills 的系统也能跑）', async () => {
    expect(await discoverSkills(join(dir, '不存在'))).toEqual([])
  })

  it('路径是文件（坏目录）→ 报错', async () => {
    const file = join(dir, 'skills.md')
    await writeFile(file, '我不是目录', 'utf8')
    await expect(discoverSkills(file)).rejects.toThrow()
  })

  it('跳过非目录项与没有 SKILL.md 的子目录', async () => {
    await mkdir(join(dir, 'tdd'))
    await mkdir(join(dir, '空目录'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), skillFile('tdd', 'TDD 纪律'), 'utf8')
    await writeFile(join(dir, 'README.md'), '不是 skill', 'utf8')
    await writeFile(join(dir, '孤立的.md'), '也不被扫描', 'utf8')

    expect((await discoverSkills(dir)).map((s) => s.name)).toEqual(['tdd'])
  })

  it('frontmatter 之后正文为空也是合法 skill（content 为空串）', async () => {
    await mkdir(join(dir, 'empty'))
    await writeFile(join(dir, 'empty', 'SKILL.md'), skillFile('empty', '空正文', ''), 'utf8')
    expect(await discoverSkills(dir)).toEqual([
      {
        name: 'empty',
        description: '空正文',
        content: '',
        modelInvocable: true,
        userInvocable: true,
      },
    ])
  })

  it('坏条目 fail-closed：空文件（无 frontmatter）→ 抛错并带文件路径', async () => {
    await mkdir(join(dir, 'broken'))
    const skillPath = join(dir, 'broken', 'SKILL.md')
    await writeFile(skillPath, '', 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/missing/)
    await expect(discoverSkills(dir)).rejects.toThrow(/SKILL\.md/)
  })

  it('坏条目 fail-closed：frontmatter 的 name 与目录名不符 → 抛错', async () => {
    await mkdir(join(dir, 'tdd'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), skillFile('poet', '写诗', '正文'), 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/poet.*tdd|does not match/)
  })

  it('坏条目 fail-closed：坏 YAML → 抛错', async () => {
    await mkdir(join(dir, 'tdd'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), '---\nname: [未闭合\n---\n正文', 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/YAML/)
  })

  it('坏条目 fail-closed：缺 description → 抛错', async () => {
    await mkdir(join(dir, 'tdd'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), '---\nname: tdd\n---\n正文', 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/description/)
  })

  it('坏条目 fail-closed：驼峰 legacy 调用键 → 抛错', async () => {
    await mkdir(join(dir, 'tdd'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), skillFile('tdd', 'x', '正文', 'userInvocable: false'), 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/userInvocable.*user-invocable/)
  })

  it('自举素材：真扫描仓库 .agents/skills，tdd skill 的 description 来自 frontmatter、content 不含 frontmatter', async () => {
    const repoSkills = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))
    const skills = await discoverSkills(repoSkills)
    expect(skills.map((s) => s.name)).toEqual(['tdd'])
    expect(skills[0]!.description).toBe(
      '测试驱动开发纪律：red→green→refactor。写任何实现代码前先写一个失败的测试；适用于 mini-deepseek-harness 的所有功能代码（插件、seam 契约、工具、UI 逻辑）。',
    )
    expect(skills[0]!.content).toContain('TDD（测试驱动开发）')
    expect(skills[0]!.content).not.toContain('---')
    expect(skills[0]!.content).not.toContain('name: tdd')
  })
})
