/**
 * M5 教程练习（步骤 2）：注册一个自己的 skill，让假 LLM 调用 skill 工具拿到全文。
 * M7 升级：SKILL.md 带 frontmatter（name 与目录名一致 + description 必填），
 * 模型拿到的是"frontmatter 之后的正文"。
 *
 * 运行：pnpm tsx packages/skill/examples/my-skill.ts
 * 玩法：把 MY_SKILL_DESCRIPTION 或正文改掉（比如加一行"回答必须押韵"），再跑一次——
 *       打印出来的"模型收到的全文"跟着变了。零 API key。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { skillsFromDirectory, skillTool } from '@mini-dsh/skill'
import { agentLoop } from '@mini-dsh/agent'

/** 你自己的 skill：frontmatter（name 必须与目录名 poet 一致 + description 必填）+ 正文。 */
const MY_SKILL_NAME = 'poet'
const MY_SKILL_DESCRIPTION = '用四句打油诗开场回答用户问题'
const MY_SKILL_BODY = '# 打油诗助手\n回答用户问题时，先用四句打油诗开场。\n'
const MY_SKILL_FILE = `---\nname: ${MY_SKILL_NAME}\ndescription: ${MY_SKILL_DESCRIPTION}\n---\n${MY_SKILL_BODY}`

async function main(): Promise<void> {
  // 1. 写一个自己的 skill：临时目录 skills/poet/SKILL.md（filesystem 发现约定）
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-my-skill-'))
  const skillsDir = join(dir, 'skills')
  await mkdir(join(skillsDir, MY_SKILL_NAME), { recursive: true })
  await writeFile(join(skillsDir, MY_SKILL_NAME, 'SKILL.md'), MY_SKILL_FILE, 'utf8')

  // 2. 最小 runtime：假 LLM 台词驱动 skill 工具（get poet）
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: join(dir, 'sessions') })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'get', name: MY_SKILL_NAME } }] },
      { content: '（接下来按打油诗助手的技能要求回答）' },
    ],
  })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(skillsFromDirectory, { dir: skillsDir })
  await ctx.plugin(skillTool)
  const session = await ctx.get('session-manager')!.create({ title: '我的 skill' })
  const fiber = await session.ctx.plugin(agentLoop)
  await fiber.ctx['agent-loop'].chat('随便问我点什么')
  await session.flush()

  // 3. 看模型收到了什么：第二次调用的 tool 消息 == frontmatter 之后的正文（frontmatter 已剥离）
  const bodyMessage = fake.requests[1]!.messages.find(
    (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === MY_SKILL_NAME,
  )
  if (!bodyMessage) throw new Error('练习断言失败：模型没有收到 poet 技能全文')
  const { name, description, content } = JSON.parse(bodyMessage.content) as {
    name: string
    description: string
    content: string
  }
  console.log(`模型收到的技能（${name}）：`)
  console.log(`  description = ${description}`)
  console.log('  content =')
  console.log(content)
  const okBody = content === MY_SKILL_BODY.trimEnd()
  const okNoFm = !content.includes('---') && !content.includes('name:')
  console.log(okBody ? '✓ 正文与磁盘一致（frontmatter 已剥离）' : '✗ 正文不一致！')
  console.log(okNoFm ? '✓ frontmatter 没有泄漏进正文' : '✗ frontmatter 泄漏进正文！')

  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
