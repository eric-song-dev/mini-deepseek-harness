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
import { skillTool, skillsFromDirectory } from '@mini-dsh/skill'
import { createRpcBridge, memoryConnectionPair, webHost } from '@mini-dsh/web'
import { createBridgeClient } from '@mini-dsh/client'
import type { ClientBridge } from '@mini-dsh/client'

/**
 * skill 自举 e2e（M5 验收核心）：真 host（webHost 门面 + 内存桥）+ 真 skill 工具 +
 * 真 filesystem 发现（仓库自己的 .agents/skills）+ 假 LLM 台词（先 list 再 get tdd）。
 * 断言模型收到的上下文含 SKILL.md 正文 —— mini 版能加载并运行自己的 TDD skill。
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
      await ctx.fiber.dispose()
    },
  }
}

describe('skill 自举（M5 验收）：假 LLM 台词驱动 skill 工具加载真 TDD skill', () => {
  let runtime: Runtime | undefined

  afterEach(async () => {
    if (runtime) {
      await runtime.stop()
      await rm(runtime.dir, { recursive: true, force: true })
      runtime = undefined
    }
  })

  it('先 list 再 get tdd → 模型收到的上下文含 SKILL.md 正文，日志完整落 turn', async () => {
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

    // 第一次往返（list）：模型看到技能名列表（tdd 在其中）
    const listMessage = fake.requests[1]!.messages.at(-1)!
    expect(listMessage.role).toBe('tool')
    expect((JSON.parse(listMessage.content) as { skills: string[] }).skills).toContain('tdd')

    // 第二次往返（get）：模型收到的技能全文 == .agents/skills/tdd/SKILL.md 文件正文
    const tddBody = await readFile(join(SKILLS_DIR, 'tdd', 'SKILL.md'), 'utf8')
    const bodyMessage = fake.requests[2]!.messages.find(
      (m) => m.role === 'tool' && (JSON.parse(m.content) as { name?: string }).name === 'tdd',
    )
    expect(bodyMessage).toBeDefined()
    expect(JSON.parse(bodyMessage!.content)).toEqual({ name: 'tdd', content: tddBody })

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
})
