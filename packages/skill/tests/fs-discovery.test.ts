import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSkills } from '@mini-dsh/skill'

/**
 * filesystem 发现（M5）：目录约定 `<dir>/<name>/SKILL.md` —— 目录名即 skill 名，
 * 正文即内容。边界行为契约：
 * - 目录不存在 → 空数组（graceful：没装 skill 的系统照常启动）；
 * - 路径是文件（坏目录）→ 报错（响亮地暴露配置错误）；
 * - 非目录项与没有 SKILL.md 的子目录跳过。
 */
describe('discoverSkills（filesystem 发现后端）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mini-dsh-skills-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('扫描目录：每个 <name>/SKILL.md 是一个 skill，name 即目录名、content 即文件正文（按名排序）', async () => {
    await mkdir(join(dir, 'tdd'))
    await mkdir(join(dir, 'notes'))
    await writeFile(join(dir, 'tdd', 'SKILL.md'), '# TDD\n先测试。', 'utf8')
    await writeFile(join(dir, 'notes', 'SKILL.md'), '# notes\n跨 session 记忆。', 'utf8')

    expect(await discoverSkills(dir)).toEqual([
      { name: 'notes', content: '# notes\n跨 session 记忆。' },
      { name: 'tdd', content: '# TDD\n先测试。' },
    ])
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
    await writeFile(join(dir, 'tdd', 'SKILL.md'), '正文', 'utf8')
    await writeFile(join(dir, 'README.md'), '不是 skill', 'utf8')
    await writeFile(join(dir, '孤立的.md'), '也不被扫描', 'utf8')

    expect((await discoverSkills(dir)).map((s) => s.name)).toEqual(['tdd'])
  })

  it('SKILL.md 正文为空也是合法 skill（content 为空串）', async () => {
    await mkdir(join(dir, 'empty'))
    await writeFile(join(dir, 'empty', 'SKILL.md'), '', 'utf8')
    expect(await discoverSkills(dir)).toEqual([{ name: 'empty', content: '' }])
  })

  it('自举素材：真扫描仓库 .agents/skills，tdd skill 的内容 == 文件正文', async () => {
    const repoSkills = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))
    const skills = await discoverSkills(repoSkills)
    expect(skills.map((s) => s.name)).toEqual(['tdd'])
    expect(skills[0]!.content).toContain('TDD（测试驱动开发）')
  })
})
