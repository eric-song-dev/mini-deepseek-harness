/**
 * M7 demo：原版 AI 技能移植验收（零 API key）。
 *
 * 三幕：
 * 1. 目录展示 —— 真 filesystem 发现扫描仓库 .agents/skills，打印 7 个技能的
 *    {name, description} 目录（description 来自 frontmatter，截断 500）；
 * 2. 按 description 路由 —— 假 LLM 台词先 list 看描述，再按描述选中
 *    code-review 并 get 全文，最终回复引用技能纪律关键词；
 * 3. 调用策略 —— 用一个 disable-model-invocation: true 的临时技能演示：
 *    list 目录里看不见它、get 返回不可调用。
 *
 * 运行：pnpm demo:skills
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { createFakeLlm } from '@mini-dsh/test-support'
import { skillsFromDirectory, skillTool } from '@mini-dsh/skill'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

/** 仓库 .agents/skills 目录（移植技能的真源）。 */
const SKILLS_DIR = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))

const clean = process.argv.includes('--clean')
const dir = join('.mini-dsh', 'demo-skills')

async function act1(ctx: Context): Promise<void> {
  console.log('===== 第一幕：技能目录（description 来自 frontmatter）=====\n')
  const catalog = (await ctx.get('skills')!).list().map((name) => ctx.get('skills')!.get(name))
  console.log(`发现 ${catalog.length} 个技能（${SKILLS_DIR}）：\n`)
  for (const skill of catalog) {
    console.log(`  ${skill.name.padEnd(20)} ${skill.description}`)
  }
  console.log()
}

async function act2(ctx: Context): Promise<void> {
  console.log('===== 第二幕：按 description 路由（台词：list → get code-review）=====\n')
  const fake = ctx.get('llm') as ReturnType<typeof createFakeLlm>
  const session: Session = await ctx.get('session-manager')!.create({ title: 'M7 skill 目录' })
  const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是一个 AI 编程助手。' })
  const loop: AgentLoop = fiber.ctx['agent-loop']
  await loop.chat('帮我审查最近一次改动')

  // 模型第一步 list 看到目录（description 是路由依据），第二步按描述 get code-review
  const listMessage = fake.requests[1]!.messages.at(-1)!
  const { skills } = JSON.parse(listMessage.content) as { skills: Array<{ name: string; description: string }> }
  console.log('模型看到的目录（节选）：')
  for (const s of skills.slice(0, 3)) console.log(`  ${s.name.padEnd(20)} ${s.description.slice(0, 60)}…`)
  console.log('  …')
  console.log('\n模型选择加载的技能与正文开头：')
  const bodyMessage = fake.requests[2]!.messages.find(
    (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'code-review',
  )
  if (!bodyMessage) throw new Error('演示断言失败：模型没有收到 code-review 技能')
  const { name, content } = JSON.parse(bodyMessage.content) as { name: string; content: string }
  console.log(`  ${name}（${content.length} 字符，frontmatter 已剥离）：`)
  console.log(`  ${content.split('\n').slice(0, 4).join('\n  ')}`)
  console.log('  …\n')
  const lastAssistant = session.log.filter((e) => e.type === 'assistant').at(-1)!
  console.log('最终回答（按技能纪律说话）：')
  console.log(`  ${(lastAssistant.payload as { content: string }).content}\n`)
}

async function act3(ctx: Context): Promise<void> {
  console.log('===== 第三幕：调用策略（disable-model-invocation 技能模型不可加载）=====\n')
  // 临时技能：translate-demo（disable-model-invocation: true —— 仅供用户显式触发）
  const skillsDir = join(dir, 'act3-skills')
  await mkdir(join(skillsDir, 'translate-demo'), { recursive: true })
  await writeFile(
    join(skillsDir, 'translate-demo', 'SKILL.md'),
    [
      '---',
      'name: translate-demo',
      'description: 人工触发的翻译流程',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '# 翻译流程',
      '只在用户显式点名时运行。',
      '',
    ].join('\n'),
    'utf8',
  )
  const probeCtx = new Context()
  await probeCtx.plugin(toolRegistry)
  await probeCtx.plugin(skillsFromDirectory, { dir: skillsDir })
  await probeCtx.plugin(skillTool)
  const tool = probeCtx.get('tools')!.get('skill')!
  const list = (await tool.execute({ action: 'list' }, { cwd: '/' })) as { skills: unknown[] }
  const get = (await tool.execute({ action: 'get', name: 'translate-demo' }, { cwd: '/' })) as { error?: string }
  console.log(`目录（list）里看得到它吗？→ ${list.skills.length} 个条目（0 = 看不见 ✓）`)
  console.log(`模型 get 它 → ${get.error ?? '（意外：拿到了正文）'}\n`)
  await probeCtx.fiber.dispose()
}

async function main(): Promise<void> {
  if (clean) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: join(dir, 'sessions') })
  await ctx.plugin(SessionManager)
  // 台词：先 list 看目录 → 按 description 选中 code-review → 按纪律总结
  await ctx.plugin(
    provideLlm,
    createFakeLlm({
      replies: [
        { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'list' } }] },
        { toolCalls: [{ id: 's2', name: 'skill', arguments: { action: 'get', name: 'code-review' } }] },
        { content: '按 code-review 纪律审查：先核对硬约束与 TDD 证据，再查契约两侧与注册可逆。' },
      ],
    }),
  )
  await ctx.plugin(toolRegistry)
  await ctx.plugin(skillsFromDirectory, { dir: SKILLS_DIR })
  await ctx.plugin(skillTool)

  await act1(ctx)
  await act2(ctx)
  await act3(ctx)

  console.log(`会话目录：${join(dir, 'sessions')}（<id>.jsonl 里是完整事件日志，可回放）`)
  console.log('提示：本 demo 的 7 个技能同时被正在运行的 DeepSeek Harness 真实发现（本会话技能目录可见）。')
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
