import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { createJsonlPersistence, jsonlPersistence } from '@mini-dsh/session'
import { runPersistenceContract } from './contracts/persistence-contract'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-session-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// seam 契约测试跑在 JSONL 后端上（这份契约将来直接复用给 SQLite 后端）。
runPersistenceContract(() => createJsonlPersistence({ dir }))

describe('JSONL 后端（实现细节）', () => {
  it('每个会话一个 <dir>/<id>.jsonl，首行是 session/created 头记录', async () => {
    const persistence = createJsonlPersistence({ dir })
    const meta = await persistence.create({ title: 'hello' })
    const raw = await readFile(join(dir, `${meta.id}.jsonl`), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      seq: 1, type: 'session/created', ts: meta.createdAt, payload: meta,
    })
  })

  it('每次 append 追加一行一条 JSON（末尾换行）', async () => {
    const persistence = createJsonlPersistence({ dir })
    const meta = await persistence.create({})
    await persistence.append(meta.id, { seq: 2, type: 'user', ts: 9, payload: { content: 'x' } })
    const raw = await readFile(join(dir, `${meta.id}.jsonl`), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toEqual({ seq: 2, type: 'user', ts: 9, payload: { content: 'x' } })
  })

  it('空目录 list 返回空数组', async () => {
    await expect(createJsonlPersistence({ dir }).list()).resolves.toEqual([])
  })

  it('jsonlPersistence 插件把后端注册成 session-persistence 服务', async () => {
    const { ctx, dispose } = await createTestContext()
    try {
      await ctx.plugin(jsonlPersistence, { dir })
      const service = ctx.get('session-persistence')
      expect(service).toBeDefined()
      expect(service).toHaveProperty('locate')
      expect(service).toHaveProperty('create')
      expect(service).toHaveProperty('append')
      expect(service).toHaveProperty('load')
      expect(service).toHaveProperty('list')
    } finally {
      await dispose()
    }
  })
})
