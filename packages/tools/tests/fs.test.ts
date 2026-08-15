import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
  editFileTool,
  readFileTool,
  toolRegistry,
  writeFileTool,
} from '@mini-dsh/tools'

/**
 * 文件工具契约（M3 spec 任务 3）：
 * 读/写往返、edit 的精确替换（恰好一次）、相对路径按会话 cwd 解析、不存在报错。
 */
describe('文件工具', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), 'mini-dsh-fs-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const read = createReadFileTool()
  const write = createWriteFileTool()
  const edit = createEditFileTool()

  it('read：读回文件内容；相对路径按会话 cwd 解析', async () => {
    await writeFile(resolve(dir, 'a.txt'), '文件内容', 'utf8')
    await expect(read.execute({ path: 'a.txt' }, { cwd: dir })).resolves.toBe('文件内容')
  })

  it('read：绝对路径不叠加 cwd', async () => {
    const path = resolve(dir, 'b.txt')
    await writeFile(path, '绝对路径内容', 'utf8')
    await expect(read.execute({ path }, { cwd: '/somewhere-else' })).resolves.toBe('绝对路径内容')
  })

  it('read：文件不存在报错（模型需要看到失败原因）', async () => {
    await expect(read.execute({ path: 'missing.txt' }, { cwd: dir })).rejects.toThrow()
  })

  it('write：写入后读回一致（往返），返回实际路径与字节数', async () => {
    const result = (await write.execute({ path: 'sub/dir/a.txt', content: '新内容' }, { cwd: dir })) as {
      path: string
      bytes: number
    }
    expect(result.path).toBe(resolve(dir, 'sub/dir/a.txt'))
    expect(result.bytes).toBe(Buffer.byteLength('新内容'))
    await expect(readFile(result.path, 'utf8')).resolves.toBe('新内容')
  })

  it('write：父目录不存在自动创建；覆盖已有文件', async () => {
    const path = resolve(dir, 'deep/nested/x.txt')
    await write.execute({ path: 'deep/nested/x.txt', content: '第一版' }, { cwd: dir })
    await write.execute({ path: 'deep/nested/x.txt', content: '第二版' }, { cwd: dir })
    await expect(readFile(path, 'utf8')).resolves.toBe('第二版')
  })

  it('edit：旧文本恰好出现一次时精确替换，返回替换成功', async () => {
    const path = resolve(dir, 'notes.md')
    await writeFile(path, '今天天气很好。', 'utf8')
    const result = (await edit.execute({ path: 'notes.md', oldText: '很好', newText: '一般' }, { cwd: dir })) as {
      path: string
      replaced: boolean
    }
    expect(result).toEqual({ path, replaced: true })
    await expect(readFile(path, 'utf8')).resolves.toBe('今天天气一般。')
  })

  it('edit：旧文本不存在报错，文件原样不动', async () => {
    const path = resolve(dir, 'notes.md')
    await writeFile(path, '原文', 'utf8')
    await expect(
      edit.execute({ path: 'notes.md', oldText: '不存在的文本', newText: 'x' }, { cwd: dir }),
    ).rejects.toThrow(/找不到旧文本/)
    await expect(readFile(path, 'utf8')).resolves.toBe('原文')
  })

  it('edit：旧文本出现多次报错（精确替换 = 恰好一次），文件原样不动', async () => {
    const path = resolve(dir, 'notes.md')
    await writeFile(path, 'aa bb aa', 'utf8')
    await expect(edit.execute({ path: 'notes.md', oldText: 'aa', newText: 'cc' }, { cwd: dir })).rejects.toThrow(
      /出现 2 次/,
    )
    await expect(readFile(path, 'utf8')).resolves.toBe('aa bb aa')
  })

  it('read/write/edit 工具插件把三个声明注册进 tools 服务', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(toolRegistry)
    await ctx.plugin(readFileTool)
    await ctx.plugin(writeFileTool)
    await ctx.plugin(editFileTool)
    try {
      const tools = ctx.get('tools')!
      expect(tools.list().map((d) => d.name)).toEqual(['read_file', 'write_file', 'edit_file'])
      for (const declaration of tools.list()) {
        expect(declaration.parameters).toEqual(
          expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({ path: expect.objectContaining({ type: 'string' }) }),
          }),
        )
      }
    } finally {
      await dispose()
    }
  })
})
