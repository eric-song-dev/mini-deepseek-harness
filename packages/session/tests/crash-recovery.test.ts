import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, projectMessages, SessionManager } from '@mini-dsh/session'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-crash-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function boot(): Promise<{ ctx: Context, manager: SessionManager, dispose: () => Promise<void> }> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  return { ctx, manager: ctx.get('session-manager')!, dispose }
}

/** 手工构造一个"崩溃现场"：进程在 turn/start 之后被杀死，没来得及 emit turn/end。 */
async function writeCrashedSession(id: string): Promise<void> {
  const createdAt = Date.now()
  const meta = { id, title: '崩溃现场', createdAt }
  const lines = [
    { seq: 1, type: 'session/created', ts: createdAt, payload: meta },
    { seq: 2, type: 'turn/start', ts: createdAt + 1 },
    { seq: 3, type: 'user', ts: createdAt + 2, payload: { content: '说到一半……' } },
  ]
  await writeFile(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

describe('崩溃恢复（M1 核心契约）', () => {
  it('resume 断尾日志：自动补 turn/end（reason: crash）并落盘', async () => {
    await writeCrashedSession('s-crash')
    const { manager, dispose } = await boot()
    try {
      const session = await manager.resume('s-crash')
      const last = session.log.at(-1)!
      expect(last.type).toBe('turn/end')
      expect(last.payload).toEqual({ reason: 'crash' })
      expect(last.seq).toBe(4)

      // 补写的事件已持久化：直接读文件最后一行
      const onDisk = (await readFile(join(dir, 's-crash.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(onDisk.at(-1)!)).toMatchObject({
        seq: 4, type: 'turn/end', payload: { reason: 'crash' },
      })
    } finally {
      await dispose()
    }
  })

  it('幂等：修复已落盘，第二次 resume 不再补', async () => {
    await writeCrashedSession('s-idem')
    {
      const { manager, dispose } = await boot()
      const first = await manager.resume('s-idem')
      expect(first.log.filter((e) => e.type === 'turn/end')).toHaveLength(1)
      await dispose()
    }
    {
      const { manager, dispose } = await boot()
      const second = await manager.resume('s-idem')
      expect(second.log.filter((e) => e.type === 'turn/end')).toHaveLength(1)
      expect(second.log.at(-1)).toMatchObject({ type: 'turn/end', payload: { reason: 'crash' } })
      await dispose()
    }
  })

  it('正常收尾的日志 resume 不补任何事件', async () => {
    const { manager, dispose } = await boot()
    const session = await manager.create({ title: '正常' })
    session.ctx.emit('turn/start')
    session.ctx.emit('user', { content: 'hi' })
    session.ctx.emit('turn/end', { reason: 'done' })
    await session.flush()
    const id = session.id
    await dispose()

    const again = await boot()
    const resumed = await again.manager.resume(id)
    expect(resumed.log.map((e) => e.type)).toEqual([
      'session/created', 'turn/start', 'user', 'turn/end',
    ])
    await again.dispose()
  })

  it('崩溃落在工具执行中：resume 合成 isError 工具结果 + turn/end 并全部落盘，transcript 恢复 wire 合法', async () => {
    // 现场：assistant 声明工具调用 → tool 调用事件已落盘 → 进程死在结果返回前
    const id = 's-dangling-tool'
    const createdAt = Date.now()
    const lines = [
      { seq: 1, type: 'session/created', ts: createdAt, payload: { id, title: '工具崩溃现场', createdAt } },
      { seq: 2, type: 'turn/start', ts: createdAt + 1 },
      { seq: 3, type: 'user', ts: createdAt + 2, payload: { content: '跑个命令' } },
      {
        seq: 4, type: 'assistant', ts: createdAt + 3,
        payload: { content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'date' } }] },
      },
      { seq: 5, type: 'tool', ts: createdAt + 4, payload: { name: 'bash', input: { command: 'date' } } },
    ]
    await writeFile(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

    const { manager, dispose } = await boot()
    try {
      const session = await manager.resume(id)
      const log = session.log
      expect(log.map((e) => e.type)).toEqual([
        'session/created', 'turn/start', 'user', 'assistant', 'tool', 'tool', 'turn/end',
      ])
      const synthesized = log[5]!
      expect(synthesized.payload).toEqual({
        name: 'bash',
        input: { command: 'date' },
        output: { isError: true, content: '工具结果丢失：进程在结果返回前崩溃' },
      })
      expect(log[6]!.payload).toEqual({ reason: 'crash' })

      // 两个补写事件都已持久化（读文件最后两行）
      const onDisk = (await readFile(join(dir, `${id}.jsonl`), 'utf8')).trim().split('\n')
      expect(JSON.parse(onDisk.at(-2)!)).toMatchObject({ seq: 6, type: 'tool', payload: { name: 'bash' } })
      expect(JSON.parse(onDisk.at(-1)!)).toMatchObject({ seq: 7, type: 'turn/end', payload: { reason: 'crash' } })

      // 恢复后的模型输入（projectMessages）以配对的 tool 结果收尾——wire 合法
      const messages = projectMessages(session.log)
      expect(messages.at(-1)).toEqual({
        role: 'tool',
        toolCallId: 'c1',
        content: '{"isError":true,"content":"工具结果丢失：进程在结果返回前崩溃"}',
      })
    } finally {
      await dispose()
    }
  })
})
