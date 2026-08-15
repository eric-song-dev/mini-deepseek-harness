import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'

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
    { seq: 4, type: 'turn/start', ts: createdAt + 3 },
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
      expect(last.seq).toBe(5)

      // 补写的事件已持久化：直接读文件最后一行
      const onDisk = (await readFile(join(dir, 's-crash.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(onDisk.at(-1)!)).toMatchObject({
        seq: 5, type: 'turn/end', payload: { reason: 'crash' },
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
})
