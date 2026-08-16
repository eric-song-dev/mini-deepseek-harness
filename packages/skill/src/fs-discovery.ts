import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { parseSkillFile } from './frontmatter'
import { createSkillsRegistry, InvalidSkillError } from './skills'
import type { Skill } from './skills'

/**
 * filesystem 发现后端（M5 建立；M7 升级为 frontmatter 契约）：目录约定
 * `<dir>/<name>/SKILL.md`——目录名即 skill 名；SKILL.md 带 YAML frontmatter
 * （`name` 必须与目录名一致、`description` 必填），content 只返回 frontmatter
 * 之后的正文。
 *
 * 边界行为（契约，见 tests/fs-discovery.test.ts）：
 * - 目录不存在 → 空数组（graceful：没装 skill 的系统照常启动）；
 * - 路径是文件（坏目录）→ 报错（响亮地暴露配置错误）；
 * - 非目录项、没有 SKILL.md 的子目录跳过；结果按名排序（确定性）；
 * - 坏 frontmatter / name 与目录名不符 / 驼峰 legacy 键 → 抛 InvalidSkillError
 *   并带文件路径（M7 fail-closed：坏条目响亮失败，绝不默认放行——与上游
 *   "警告 + 跳过"的有意偏离：mini 是单根开发者自管仓库，坏 skill 与坏
 *   profile 一样是配置错误）。
 */

/** 扫描目录发现全部 skill（按名排序）。 */
export async function discoverSkills(dir: string): Promise<Skill[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // 目录不存在：没有 skill 也是一种合法状态（graceful）
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const skills: Skill[] = []
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue
    const skillFile = join(dir, entry.name, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(skillFile, 'utf8')
    } catch (error) {
      // 子目录里没有 SKILL.md：不是 skill，跳过（读失败的其他原因原样上抛）
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    skills.push(parseSkillAt(skillFile, raw, entry.name))
  }
  return skills
}

/** 解析一个 SKILL.md；格式违约抛 InvalidSkillError（消息带文件路径）。 */
function parseSkillAt(skillFile: string, raw: string, dirName: string): Skill {
  try {
    const parsed = parseSkillFile(raw, dirName)
    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
    }
  } catch (error) {
    if (error instanceof InvalidSkillError) {
      throw new InvalidSkillError(`skill 文件 ${skillFile}：${error.message}`)
    }
    throw error
  }
}

export interface SkillsFromDirectoryOptions {
  /** skill 根目录（每个子目录 `<name>/SKILL.md` 是一个 skill）。 */
  dir: string
}

/**
 * 插件：扫描目录 → 把发现的 skill 注册进默认注册表 → 提供 `skills` 服务。
 *
 * M6 注册可逆说明：这里不逐个挂 ctx.effect——注册表由本插件自建并经
 * `ctx.provide` 提供，插件卸载时 cordis 撤销服务、注册表整体随闭包消亡
 * （与 webHost 自建桥同款路径）。单个 skill 的撤销语义由 SkillsService.register
 * 的返回函数承担（契约测试覆盖），注册方按需使用。
 */
export const skillsFromDirectory = Object.assign(
  async function skillsFromDirectory(ctx: Context, options: SkillsFromDirectoryOptions): Promise<void> {
    const skills = await discoverSkills(options.dir)
    const registry = createSkillsRegistry()
    for (const skill of skills) registry.register(skill)
    ctx.provide('skills', registry)
  },
  {},
)
