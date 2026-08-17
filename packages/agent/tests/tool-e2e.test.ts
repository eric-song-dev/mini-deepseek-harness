import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, editFileTool, readFileTool, toolRegistry, writeFileTool } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'

/**
 * M3 端到端（零 key）：最小 runtime + **真 bash/fs 工具**（不是探针）。
 * 场景：模型"读文件 → 改文件 → 回答"真实完成，全量事件入日志（JSONL 落盘），
 * 模拟重启 resume 后历史（含工具往返）完整、可继续。
 */
describe('端到端：真 bash/fs 工具完成读→改→答（M3）', () => {
  let root: string
  let sessions: string
  let workspace: string

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'mini-dsh-tool-e2e-'))
    sessions = resolve(root, 'sessions')
    workspace = resolve(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(resolve(workspace, 'a.txt'), 'M3 之前的旧内容', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** 启动一套最小 runtime：JSONL 后端 + SessionManager + 假 LLM + 真工具（bash/read/write/edit）。 */
  async function boot(script: Parameters<typeof createFakeLlm>[0]['replies']) {
    const ctx = new Context()
    await ctx.plugin(jsonlPersistence, { dir: sessions })
    await ctx.plugin(SessionManager)
    const fake = createFakeLlm({ replies: script })
    await ctx.plugin(provideLlm, fake)
    await ctx.plugin(toolRegistry)
    await ctx.plugin(bashTool)
    await ctx.plugin(readFileTool)
    await ctx.plugin(writeFileTool)
    await ctx.plugin(editFileTool)
    return {
      ctx,
      manager: ctx.get('session-manager')!,
      fake,
      stop: () => ctx.fiber.dispose(),
    }
  }

  async function attachLoop(session: Session): Promise<AgentLoop> {
    const fiber = await session.ctx.plugin(agentLoop, { systemPrompt: '你是文件助手' })
    return fiber.ctx['agent-loop']
  }

  it('模型读文件→改文件→回答：真实文件被改、全量事件入日志、模型每步看到真工具结果', async () => {
    const runtime = await boot([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }] },
      { toolCalls: [{ id: 'c2', name: 'edit', arguments: { file_path: 'a.txt', old_string: '旧', new_string: '新' } }] },
      { content: '文件已更新。' },
    ])
    const session = await runtime.manager.create({ title: 'M3 端到端', cwd: workspace })
    const loop = await attachLoop(session)
    await loop.chat('帮我更新 a.txt')
    await session.flush()

    // 真实文件被改
    await expect(readFile(resolve(workspace, 'a.txt'), 'utf8')).resolves.toBe('M3 之前的新内容')

    // 全量事件日志（工具调用/结果对是真实输出）
    expect(session.log.map((e) => e.type)).toEqual([
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
    expect(session.log[5]!.payload).toEqual({
      name: 'read',
      input: { file_path: 'a.txt' },
      output: 'M3 之前的旧内容',
    })
    expect(session.log[8]!.payload).toEqual({
      name: 'edit',
      input: { file_path: 'a.txt', old_string: '旧', new_string: '新' },
      output: { path: resolve(workspace, 'a.txt'), replaced: true },
    })
    expect(session.log[9]!.payload).toEqual({ content: '文件已更新。', usage: { inputTokens: 1, outputTokens: 1 } })
    expect(session.log[10]!.payload).toEqual({ reason: 'done' })

    // 模型第二步看到的 messages 含第一步的真实工具结果（role:tool 回填）
    expect(runtime.fake.requests[1]!.messages).toEqual([
      { role: 'system', content: '你是文件助手' },
      { role: 'user', content: '帮我更新 a.txt' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'c1', content: '"M3 之前的旧内容"' },
    ])

    // JSONL 真源：头记录 + 10 条事件
    const lines = (await readFile(resolve(sessions, `${session.id}.jsonl`), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(11)
    await runtime.stop()
  })

  it('bash 工具真实执行：exit code/输出进 tool 结果事件（模型看到失败原因，非异常）', async () => {
    const runtime = await boot([
      { toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo hi; echo boom 1>&2; exit 3' } }] },
      { content: '命令跑完了（退出码 3）。' },
    ])
    const session = await runtime.manager.create({ title: 'bash 端到端', cwd: workspace })
    const loop = await attachLoop(session)
    await loop.chat('跑个命令')
    await session.flush()

    expect(session.log[5]!.payload).toEqual({
      name: 'bash',
      input: { command: 'echo hi; echo boom 1>&2; exit 3' },
      output: { stdout: 'hi\n', stderr: 'boom\n', exitCode: 3 },
    })
    expect(session.log[6]!.payload).toEqual({ content: '命令跑完了（退出码 3）。', usage: { inputTokens: 1, outputTokens: 1 } })
    await runtime.stop()
  })

  it('工具往返后重启 resume：历史完整、新模型输入包含全部工具往返、可继续', async () => {
    let id: string
    {
      const runtime = await boot([
        { toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }] },
        { content: '读完了。' },
      ])
      const session = await runtime.manager.create({ title: 'M3 resume', cwd: workspace })
      const loop = await attachLoop(session)
      await loop.chat('读一下 a.txt')
      await session.flush()
      id = session.id
      await runtime.stop()
    }
    {
      const runtime = await boot([{ content: '续聊回答' }])
      const resumed = await runtime.manager.resume(id)
      const loop = await attachLoop(resumed)
      await loop.chat('刚才读到什么？')
      await resumed.flush()

      // 新进程的模型输入：完整历史（含工具往返的 assistant+tool 对）+
      expect(runtime.fake.requests[0]!.messages).toEqual([
        { role: 'system', content: '你是文件助手' },
        { role: 'user', content: '读一下 a.txt' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'c1', content: '"M3 之前的旧内容"' },
        { role: 'assistant', content: '读完了。' },
        { role: 'user', content: '刚才读到什么？' },
      ])
      // 日志继续追加：两轮 + 一轮工具往返
      expect(resumed.log.map((e) => e.type)).toEqual([
        'session/created',
        'turn/start',
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
        'turn/end',
        'turn/start',
        'user',
        'assistant',
        'turn/end',
      ])
      await runtime.stop()
    }
  })
})
