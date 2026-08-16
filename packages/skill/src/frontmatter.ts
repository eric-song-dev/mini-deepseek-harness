import { parse as parseYaml } from 'yaml'
import { InvalidSkillError, isSkillName } from './skills'

/**
 * SKILL.md frontmatter 解析（M7 任务 2，上游 skill-filesystem 的
 * parseFrontmatter / parseSkillFile / parseInvocationPolicy 契约 mini 版）。
 *
 * 格式契约（照搬上游概念，代码自写）：
 * - 首行必须恰为 `---`（容忍 CRLF），找到下一个独立成行的 `---` 闭合；
 * - 中间是 YAML（`yaml` 包解析，须为普通对象）；
 * - 必填 `name`（kebab-case，与目录名一致由调用方校验）+ `description`；
 * - 可选 `whenToUse`（非字符串省略——不授予调用权，不必排除条目）、
 *   `disable-model-invocation` / `user-invocable`（宽松布尔清单，默认允许）；
 * - fail-closed：驼峰 legacy 键、非布尔调用值、坏 YAML、name 不符 → 抛
 *   InvalidSkillError，条目被排除——绝不把无效数据当默认放行；
 * - content 只返回闭合行之后的正文（trim），frontmatter 已剥离。
 */

/** parseFrontmatter 的结果：YAML 数据对象 + frontmatter 之后的正文（未 trim）。 */
export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

/** parseSkillFile 的结果：一个完整校验过的 skill（content 已剥离 frontmatter）。 */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

/**
 * 解析 YAML frontmatter。首行不是 `---` → undefined（没有 frontmatter）；
 * 有开头没闭合、坏 YAML、顶层非对象 → 抛 InvalidSkillError（坏文件要响亮）。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const closing = findClosingFrontmatter(raw, firstLineEnd + 1)
  if (closing === undefined) {
    throw new InvalidSkillError('unterminated YAML frontmatter：有开头 --- 却没有闭合 ---')
  }
  const yamlText = raw.slice(firstLineEnd + 1, closing.start)
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch (error) {
    throw new InvalidSkillError(`invalid YAML frontmatter：${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidSkillError('YAML frontmatter must be a plain object')
  }
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

/** 找独立成行的闭合 `---`（容忍 CRLF）。 */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * 解析并校验一个完整的 SKILL.md 文件。expectedName 给定时（filesystem 发现：
 * 目录名），校验 frontmatter 的 name 与之一致——发现期只留一个可寻址名字。
 * 任何违反格式契约的情况抛 InvalidSkillError（fail-closed）。
 */
export function parseSkillFile(raw: string, expectedName?: string): ParsedSkill {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) {
    throw new InvalidSkillError('missing YAML frontmatter：SKILL.md 必须以 --- name/description --- 开头')
  }
  const { data } = parsed
  const name = stringField(data, 'name')
  if (name === undefined) throw new InvalidSkillError('frontmatter requires name')
  const description = stringField(data, 'description')
  if (description === undefined) throw new InvalidSkillError('frontmatter requires description')
  if (!isSkillName(name)) throw new InvalidSkillError(`invalid skill name "${name}"`)
  if (expectedName !== undefined && name !== expectedName) {
    throw new InvalidSkillError(`skill name "${name}" does not match directory "${expectedName}"`)
  }
  const invocation = parseInvocationPolicy(data)
  const whenToUse = stringField(data, 'whenToUse')
  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    modelInvocable: invocation.modelInvocable,
    userInvocable: invocation.userInvocable,
    content: parsed.body.trim(),
  }
}

/** 非空字符串字段；缺失/空串/类型错 → undefined。 */
function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 调用策略：两个负向/正向键规范化为两个正向布尔；省略默认允许（四象限）。 */
function parseInvocationPolicy(data: Record<string, unknown>): { modelInvocable: boolean; userInvocable: boolean } {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** 驼峰 legacy 键显式抛错并给出规范键名（上游同款 fail-closed）。 */
function rejectLegacyInvocationKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new InvalidSkillError(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

/** 宽松布尔：YAML 布尔 + true/false/yes/no/on/off/1/0（不区分大小写）；其余抛错。 */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new InvalidSkillError(`frontmatter field "${key}" must be a boolean`)
}
