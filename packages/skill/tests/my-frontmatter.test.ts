import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSkills } from '@mini-dsh/skill'

/**
 * M7 教程练习：玩坏一个 SKILL.md 的 frontmatter，看发现器怎么反应。
 *
 * 运行：pnpm vitest run --project node packages/skill/tests/my-frontmatter.test.ts
 * 玩法（教程 M7-upstream-skills 的练习 1）：
 * 1. 先跑一次 → 绿；
 * 2. 把下面 SKILL.md 的 description 行删掉 → 跑一次 → 红（报"requires description"）；
 * 3. 把 name 改成 joker（与目录名 my-tip 不一致）→ 红（报"does not match"）；
 * 4. 改回原样 → 绿。fail-closed = 坏条目响亮失败，绝不默认放行。
 */
describe('我的 frontmatter 练习（M7 教程）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mini-dsh-my-frontmatter-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('my-tip 技能的 description 进目录、正文剥离 frontmatter', async () => {
    await mkdir(join(dir, 'my-tip'))
    // TODO(练习)：试试删掉 description 行 / 改坏 name —— 看它怎么红，再改回来
    await writeFile(
      join(dir, 'my-tip', 'SKILL.md'),
      '---\nname: my-tip\ndescription: 回答前先说一个冷笑话\n---\n# 我的技能\n先说笑话。\n',
      'utf8',
    )
    const [skill] = await discoverSkills(dir)
    expect(skill!.description).toBe('回答前先说一个冷笑话')
    expect(skill!.content).toBe('# 我的技能\n先说笑话。')
  })

  it('frontmatter 里的 name 必须与目录名一致', async () => {
    await mkdir(join(dir, 'my-tip'))
    await writeFile(join(dir, 'my-tip', 'SKILL.md'), '---\nname: my-tip\ndescription: 冷笑话助手\n---\n正文', 'utf8')
    // 发现期校验：目录名 my-tip 与 frontmatter name 不符会抛错（fail-closed）
    const mismatch = '---\nname: joker\ndescription: 冷笑话助手\n---\n正文'
    await writeFile(join(dir, 'my-tip', 'SKILL.md'), mismatch, 'utf8')
    await expect(discoverSkills(dir)).rejects.toThrow(/joker.*my-tip|does not match/)
    // 改回来 → 绿
    await writeFile(join(dir, 'my-tip', 'SKILL.md'), '---\nname: my-tip\ndescription: 冷笑话助手\n---\n正文', 'utf8')
    expect((await discoverSkills(dir)).map((s) => s.name)).toEqual(['my-tip'])
  })
})
