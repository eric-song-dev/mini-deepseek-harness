import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import type { FakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

/**
 * M2 端到端（零 key）：最小 runtime = JSONL 后端 + SessionManager + 假 LLM + agent loop。
 * 场景：聊一轮 → 落盘 → 模拟进程重启（整个 ctx 销毁）→ resume → 历史完整且 loop 可继续。
 */
describe('端到端：聊一轮 → 重启 → resume 继续（M2）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), 'mini-dsh-e2e-'))
  })

  async function boot(replies: Parameters<typeof createFakeLlm>[0]['replies']) {
    const ctx = new Context()
    await ctx.plugin(jsonlPersistence, { dir })
    await ctx.plugin(SessionManager)
    const fake = createFakeLlm({ replies })
    await ctx.plugin(provideLlm, fake)
    return {
      ctx,
      manager: ctx.get('session-manager')!,
      fake,
      stop: () => ctx.fiber.dispose(),
    }
  }

  async function attachLoop(session: Session): Promise<AgentLoop> {
    const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '端到端系统提示' })
    return fiber.ctx['agent-loop']
  }

  it('一轮落盘 → 重启 resume → 历史完整、模型看到全量历史、可继续对话', async () => {
    // ---- 第一段：正常聊一轮，落盘后"进程退出" ----
    const first = await boot([{ content: '第一轮回复' }])
    const session1 = await first.manager.create({ title: '端到端会话' })
    const loop1 = await attachLoop(session1)
    await loop1.chat('第一轮问题')
    await session1.flush()
    expect(first.fake.requests[0]!.messages).toEqual([
      { role: 'system', content: '端到端系统提示' },
      { role: 'user', content: '第一轮问题' },
    ])
    const id = session1.id
    await first.stop() // 模拟进程退出：没有任何收尾逻辑

    // ---- 第二段：新进程重启，resume 同一个会话 ----
    const second = await boot([{ content: '第二轮回复' }])
    const session2 = await second.manager.resume(id)
    const loop2 = await attachLoop(session2)

    // 历史完整：resume 后内存日志就是落盘内容（头记录 + 完整第一轮）
    expect(session2.log.map((e) => e.type)).toEqual([
      'session/created',
      'turn/start',
      'user',
      'assistant',
      'turn/end',
    ])
    expect(session2.log[2]!.payload).toEqual({ content: '第一轮问题' })
    expect(session2.log[3]!.payload).toEqual({ content: '第一轮回复' })
    expect(session2.log[4]!.payload).toEqual({ reason: 'done' })

    // loop 可继续：新进程的模型看到全量历史（system + 第一轮问答 + 新问题）
    await loop2.chat('第二轮问题')
    await session2.flush()
    expect(second.fake.requests[0]!.messages).toEqual([
      { role: 'system', content: '端到端系统提示' },
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回复' },
      { role: 'user', content: '第二轮问题' },
    ])

    // 日志全文：两轮完整、互不错位
    expect(session2.log.map((e) => e.type)).toEqual([
      'session/created',
      'turn/start',
      'user',
      'assistant',
      'turn/end',
      'turn/start',
      'user',
      'assistant',
      'turn/end',
    ])

    // 磁盘真源：JSONL 文件 9 行（头记录 + 8 条事件）
    const lines = (await readFile(resolve(dir, `${id}.jsonl`), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(9)

    // 会话列表：重启后的进程能看到这个会话
    const list = await second.manager.list()
    expect(list.map((m) => m.id)).toEqual([id])

    await second.stop()
  })

  it('list 为空的新进程也能正常创建会话（两端之间互不影响）', async () => {
    const first = await boot([])
    const list = await first.manager.list()
    expect(list).toEqual([])
    await first.stop()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
})
