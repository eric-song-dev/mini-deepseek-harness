import { describe, expect, it } from 'vitest'
import { InvalidSkillError, parseFrontmatter, parseSkillFile } from '@mini-dsh/skill'

/**
 * frontmatter 解析（M7 任务 2，上游 skill-filesystem 的 parseFrontmatter/
 * parseSkillFile 契约 mini 版）：
 *
 * - SKILL.md 首行必须恰为 `---`，找到独立成行的闭合 `---`，中间是 YAML；
 * - 必填 name（kebab-case）+ description；可选 whenToUse、disable-model-invocation、
 *   user-invocable；调用字段接受布尔与 true/false/yes/no/on/off/1/0；
 * - 驼峰 legacy 键显式抛错；非布尔调用值抛错（fail-closed：排除而非默认放行）；
 * - name 与 expectedName（目录名）不符抛错；
 * - content 只返回 frontmatter 之后的正文（trim），frontmatter 已剥离。
 */

describe('parseFrontmatter（首行 --- + 闭合 --- + YAML 对象）', () => {
  it('解析完整 frontmatter：data 是字段对象，body 是闭合行之后的全文', () => {
    const raw = '---\nname: tdd\ndescription: 纪律\n---\n# 正文\n先写测试。\n'
    expect(parseFrontmatter(raw)).toEqual({
      data: { name: 'tdd', description: '纪律' },
      body: '# 正文\n先写测试。\n',
    })
  })

  it('首行不是 --- → undefined（没有 frontmatter）', () => {
    expect(parseFrontmatter('# 纯正文文件\n没有 frontmatter。')).toBeUndefined()
  })

  it('首行是 --- 但没有闭合 --- → 抛错（声称有 frontmatter 却没收尾，是坏文件）', () => {
    expect(() => parseFrontmatter('---\nname: tdd\n没有闭合')).toThrow(InvalidSkillError)
    expect(() => parseFrontmatter('---\nname: tdd\n没有闭合')).toThrow(/unterminated/)
  })

  it('YAML 语法坏 → 抛 InvalidSkillError（fail-closed：坏数据不进注册表）', () => {
    expect(() => parseFrontmatter('---\nname: [未闭合\n---\n正文')).toThrow(InvalidSkillError)
    expect(() => parseFrontmatter('---\nname: [未闭合\n---\n正文')).toThrow(/YAML/)
  })

  it('顶层不是普通对象（数组）→ 抛错', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\n正文')).toThrow(InvalidSkillError)
    expect(() => parseFrontmatter('---\n- a\n- b\n---\n正文')).toThrow(/object/)
  })

  it('容忍 CRLF 行尾（首行 ---\\r 也算 frontmatter 开头）', () => {
    const raw = '---\r\nname: tdd\r\ndescription: 纪律\r\n---\r\n正文\r\n'
    expect(parseFrontmatter(raw)).toEqual({ data: { name: 'tdd', description: '纪律' }, body: '正文\r\n' })
  })
})

describe('parseSkillFile（完整校验：name/description/调用策略/content）', () => {
  it('完整合法 → name/description/whenToUse 透传，调用策略规范化，content 剥离 frontmatter 并 trim', () => {
    const raw = [
      '---',
      'name: tdd',
      'description: 测试驱动开发纪律',
      'whenToUse: 写功能代码前',
      '---',
      '',
      '# TDD',
      '先写失败的测试。',
      '',
    ].join('\n')
    expect(parseSkillFile(raw, 'tdd')).toEqual({
      name: 'tdd',
      description: '测试驱动开发纪律',
      whenToUse: '写功能代码前',
      modelInvocable: true,
      userInvocable: true,
      content: '# TDD\n先写失败的测试。',
    })
  })

  it('无 frontmatter → 抛 missing YAML frontmatter', () => {
    expect(() => parseSkillFile('# 没有 frontmatter', 'tdd')).toThrow(InvalidSkillError)
    expect(() => parseSkillFile('# 没有 frontmatter', 'tdd')).toThrow(/missing/)
  })

  it('缺 name / 缺 description → 抛错', () => {
    expect(() => parseSkillFile('---\ndescription: 只有描述\n---\n正文', 'x')).toThrow(/name/)
    expect(() => parseSkillFile('---\nname: x\n---\n正文', 'x')).toThrow(/description/)
  })

  it('name 非 kebab-case → 抛 invalid skill name', () => {
    expect(() => parseSkillFile('---\nname: Bad_Name\ndescription: x\n---\n正文', 'Bad_Name')).toThrow(/invalid skill name/)
  })

  it('name 与目录名（expectedName）不符 → 抛错（发现期只留一个可寻址名字）', () => {
    expect(() =>
      parseSkillFile('---\nname: poet\ndescription: x\n---\n正文', 'tdd'),
    ).toThrow(/poet.*tdd|does not match/)
  })

  it('驼峰 legacy 调用键 → 显式抛错并给出规范键名（fail-closed：不静默放行）', () => {
    expect(() => parseSkillFile('---\nname: tdd\ndescription: x\ndisableModelInvocation: true\n---\n正文', 'tdd')).toThrow(
      /disableModelInvocation.*disable-model-invocation/,
    )
    expect(() => parseSkillFile('---\nname: tdd\ndescription: x\nmodelInvocable: false\n---\n正文', 'tdd')).toThrow(
      /modelInvocable.*disable-model-invocation/,
    )
    expect(() => parseSkillFile('---\nname: tdd\ndescription: x\nuserInvocable: false\n---\n正文', 'tdd')).toThrow(
      /userInvocable.*user-invocable/,
    )
  })

  it('调用值不是布尔也不在宽松清单 → 抛 must be a boolean', () => {
    expect(() => parseSkillFile('---\nname: tdd\ndescription: x\nuser-invocable: maybe\n---\n正文', 'tdd')).toThrow(
      /must be a boolean/,
    )
  })

  it('宽松布尔清单：yes/no/on/off/1/0 与真布尔等价', () => {
    const withField = (field: string, value: string) =>
      `---\nname: tdd\ndescription: x\n${field}: ${value}\n---\n正文`
    expect(parseSkillFile(withField('disable-model-invocation', 'yes'), 'tdd').modelInvocable).toBe(false)
    expect(parseSkillFile(withField('disable-model-invocation', 'on'), 'tdd').modelInvocable).toBe(false)
    expect(parseSkillFile(withField('disable-model-invocation', '1'), 'tdd').modelInvocable).toBe(false)
    expect(parseSkillFile(withField('disable-model-invocation', 'false'), 'tdd').modelInvocable).toBe(true)
    expect(parseSkillFile(withField('user-invocable', 'no'), 'tdd').userInvocable).toBe(false)
    expect(parseSkillFile(withField('user-invocable', 'off'), 'tdd').userInvocable).toBe(false)
    expect(parseSkillFile(withField('user-invocable', '0'), 'tdd').userInvocable).toBe(false)
    expect(parseSkillFile(withField('user-invocable', 'TRUE'), 'tdd').userInvocable).toBe(true)
  })

  it('whenToUse 非字符串 → 省略该字段（不授予调用权，不必排除整个 skill）', () => {
    const parsed = parseSkillFile('---\nname: tdd\ndescription: x\nwhenToUse: 3\n---\n正文', 'tdd')
    expect(parsed.whenToUse).toBeUndefined()
    expect(parsed.name).toBe('tdd')
  })

  it('content 是 body 的 trim，不含任何 frontmatter 行', () => {
    const raw = '---\nname: tdd\ndescription: x\n---\n   \n# 正文\n\n'
    const parsed = parseSkillFile(raw, 'tdd')
    expect(parsed.content).toBe('# 正文')
    expect(parsed.content).not.toContain('---')
    expect(parsed.content).not.toContain('name:')
  })

  it('expectedName 省略时不做目录名校验（纯解析原语）', () => {
    const parsed = parseSkillFile('---\nname: tdd\ndescription: x\n---\n正文')
    expect(parsed.name).toBe('tdd')
  })
})
