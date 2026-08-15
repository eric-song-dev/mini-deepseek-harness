/**
 * M5 教程练习（步骤 2）：注册一个自己的 skill，让假 LLM 调用 skill 工具拿到全文。
 *
 * 运行：pnpm tsx packages/skill/examples/my-skill.ts
 * 玩法：把 MY_SKILL_BODY 改掉（比如加一行"回答必须押韵"），再跑一次——
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

/** 你自己的 skill 正文（目录名即技能名：poet）。 */
const MY_SKILL_BODY = '# 打油诗助手\n回答用户问题时，先用四句打油诗开场。\n'

async function main(): Promise<void> {
  // 1. 写一个自己的 skill：临时目录 skills/poet/SKILL.md（filesystem 发现约定）
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-my-skill-'))
  const skillsDir = join(dir, 'skills')
  await mkdir(join(skillsDir, 'poet'), { recursive: true })
  await writeFile(join(skillsDir, 'poet', 'SKILL.md'), MY_SKILL_BODY, 'utf8')

  // 2. 最小 runtime：假 LLM 台词驱动 skill 工具（get poet）
  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: join(dir, 'sessions') })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({
    replies: [
      { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'get', name: 'poet' } }] },
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

  // 3. 看模型收到了什么：第二次调用的 tool 消息 == 你的 SKILL.md 正文
  const bodyMessage = fake.requests[1]!.messages.find(
    (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'poet',
  )
  if (!bodyMessage) throw new Error('练习断言失败：模型没有收到 poet 技能全文')
  const { content } = JSON.parse(bodyMessage.content) as { content: string }
  console.log('模型收到的我的 skill 全文：')
  console.log(content)
  console.log(content === MY_SKILL_BODY ? '✓ 与磁盘文件一致' : '✗ 不一致！')

  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
