import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { toolRegistry } from '@mini-dsh/tools'
import { parseSkillFile, skillTool, skillsFromDirectory } from '@mini-dsh/skill'
import { createRpcBridge, memoryConnectionPair, webHost } from '@mini-dsh/web'
import { createBridgeClient } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * skill 自举 e2e（M5 验收建立；M7 升级为 frontmatter 契约验收）：真 host
 * （webHost 门面 + 内存桥）+ 真 skill 工具 + 真 filesystem 发现（仓库自己的
 * .agents/skills）+ 假 LLM 台词。断言：
 * - 目录（list）返回全部 7 个技能（tdd + 6 个移植技能）的 {name, description}；
 * - get 返回的 content == 文件 frontmatter 之后的正文（用 parseSkillFile 对照，
 *   不硬编码全文）；
 * - 假 LLM 按 description 路由：先 list 看描述、再 get 对应技能、最终回复引用
 *   技能关键词——描述真的能驱动路由。
 * 只有 LLM 是假的（零 API key），其余全部是真实链路。
 */

/** 仓库 .agents/skills 目录（自举素材的真源）。 */
const SKILLS_DIR = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))

interface Runtime {
  ctx: Context
  fake: FakeLlm
  client: ClientBridge
  dir: string
  stop: () => Promise<void>
}

async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies']): Promise<Runtime> {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-skill-boot-'))
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  const fake = createFakeLlm({ replies })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  // skills 来源是真实文件系统：仓库自己的 .agents/skills（自举）
  await ctx.plugin(skillsFromDirectory, { dir: SKILLS_DIR })
  await ctx.plugin(skillTool)
  const bridge = createRpcBridge()
  const [hostSide, clientSide] = memoryConnectionPair()
  bridge.accept(hostSide)
  await ctx.plugin(webHost, { port: 0, bridge, stream: true })
  const client = createBridgeClient(clientSide)
  return {
    ctx,
    fake,
    client,
    dir,
    stop: async () => {
      client.close()
      // 先显式关 webHost（含会话 flush 落盘），再卸载插件作用域——否则落盘会撞上测试目录清理
      await ctx.get('web-host')!.close()
      await ctx.fiber.dispose()
    },
  }
}

/** 仓库中某个技能的"frontmatter 之后正文"（真源对照）。 */
async function bodyOf(name: string): Promise<string> {
  const raw = await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')
  return parseSkillFile(raw, name).content
}

describe('skill 自举（M7 验收）：假 LLM 台词驱动 skill 工具加载真技能目录', () => {
  let runtime: Runtime | undefined

  afterEach(async () => {
    if (runtime) {
      await runtime.stop()
      await rm(runtime.dir, { recursive: true, force: true })
      runtime = undefined
    }
  })

  it('先 list 再 get tdd → 目录含全部 7 个技能的 description，模型收到的 content == 剥离 frontmatter 的正文，日志完整落 turn', async () => {
    runtime = await boot([
      { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'list' } }] },
      { toolCalls: [{ id: 's2', name: 'skill', arguments: { action: 'get', name: 'tdd' } }] },
      { content: '好，我按 TDD 纪律来：先写一个失败的测试。' },
    ])
    const { fake, client } = runtime

    const created = await client.request<{ meta: { id: string } }>('session.create', { title: 'skill 自举' })
    await client.request('session.send', { id: created.meta.id, content: '加载 TDD 技能，并按它说话' })

    // 三次调用都把 skill 工具的声明给了模型（走协议 tools 参数，不是 prompt 拼接）
    expect(fake.requests.map((r) => r.tools.map((t) => t.name))).toEqual([
      ['skill'], ['skill'], ['skill'],
    ])

    // 第一次往返（list）：模型看到完整技能目录——7 个技能，每个都是 {name, description}
    const listMessage = fake.requests[1]!.messages.at(-1)!
    expect(listMessage.role).toBe('tool')
    const catalog = (JSON.parse(listMessage.content) as { skills: Array<{ name: string; description: string }> }).skills
    expect(catalog.map((s) => s.name)).toEqual([
      'archive-agent-notes',
      'code-review',
      'doc-standards',
      'pre-push-checks',
      'prose-standard',
      'tdd',
      'trim-cot-leakage',
    ])
    for (const entry of catalog) {
      expect(entry.description.length).toBeGreaterThan(0)
    }

    // 第二次往返（get）：模型收到的技能正文 == 文件 frontmatter 之后的正文（不含 frontmatter）
    const tddBody = await bodyOf('tdd')
    expect(tddBody).toContain('TDD（测试驱动开发）')
    expect(tddBody).not.toContain('---')
    const bodyMessage = fake.requests[2]!.messages.find(
      (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'tdd',
    )
    expect(bodyMessage).toBeDefined()
    expect(JSON.parse(bodyMessage!.content)).toEqual({
      name: 'tdd',
      description: expect.stringContaining('测试驱动开发纪律'),
      content: tddBody,
    })

    // 日志真源：两次工具往返 + 三次 assistant + turn/end done，全部落盘
    const resumed = await client.request<{ events: Array<{ type: string; payload: unknown }> }>(
      'session.resume',
      { id: created.meta.id },
    )

    // 最终回答按 TDD 说话：技能内容真的进了上下文，不是摆设
    expect(
      resumed.events.filter((e) => e.type === 'assistant').at(-1)!.payload,
    ).toMatchObject({ content: expect.stringContaining('先写一个失败的测试') })
    expect(resumed.events.map((e) => e.type)).toEqual([
      'session/created',
      'turn/start',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'turn/end',
    ])
    expect(resumed.events.at(-1)!.payload).toEqual({ reason: 'done' })
  })

  it('按 description 路由：台词先 list 看描述、再 get trim-cot-leakage → 最终回复引用技能关键词', async () => {
    runtime = await boot([
      { toolCalls: [{ id: 's1', name: 'skill', arguments: { action: 'list' } }] },
      { toolCalls: [{ id: 's2', name: 'skill', arguments: { action: 'get', name: 'trim-cot-leakage' } }] },
      { content: '按分类学检查：这行"以前"是变更叙事，改成现在时。' },
    ])
    const { fake, client } = runtime

    const created = await client.request<{ meta: { id: string } }>('session.create', { title: '按描述路由' })
    await client.request('session.send', { id: created.meta.id, content: '这段注释读起来像泄漏的推理过程，帮我检查' })

    // 目录里 trim-cot-leakage 的 description 含"泄漏的推理过程"关键词——描述是路由的依据
    const listMessage = fake.requests[1]!.messages.at(-1)!
    const catalog = (JSON.parse(listMessage.content) as { skills: Array<{ name: string; description: string }> }).skills
    expect(catalog.find((s) => s.name === 'trim-cot-leakage')!.description).toContain('泄漏的推理过程')

    // 模型收到的正文 == 真文件的剥离正文
    const body = await bodyOf('trim-cot-leakage')
    const bodyMessage = fake.requests[2]!.messages.find(
      (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'trim-cot-leakage',
    )
    expect(JSON.parse(bodyMessage!.content)).toEqual({
      name: 'trim-cot-leakage',
      description: expect.stringContaining('泄漏的推理过程'),
      content: body,
    })

    // 最终回复引用了技能的分类学关键词：内容真的进了上下文
    const resumed = await client.request<{ events: Array<{ type: string; payload: unknown }> }>(
      'session.resume',
      { id: created.meta.id },
    )
    expect(
      resumed.events.filter((e) => e.type === 'assistant').at(-1)!.payload,
    ).toMatchObject({ content: expect.stringContaining('变更叙事') })
  })
})
