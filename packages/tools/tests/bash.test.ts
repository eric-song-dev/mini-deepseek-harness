import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext } from '@mini-dsh/test-support'
import { bashTool, createBashTool, toolRegistry } from '@mini-dsh/tools'

/**
 * bash 工具契约（M3 spec 任务 3）：
 * stdout/stderr/exit code 透传；命令执行失败也算"成功的结果"（exit code 是输出不是异常——
 * 模型需要看到失败原因）；cwd 按 input.cwd ?? 会话 ctx.cwd。
 */
describe('bash 工具', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), 'mini-dsh-bash-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const bash = createBashTool()

  it('stdout 透传，退出码 0', async () => {
    await expect(bash.execute({ command: 'echo hello' }, { cwd: dir })).resolves.toEqual({
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
    })
  })

  it('stderr 与退出码透传；非零退出不抛错（失败也是结果）', async () => {
    await expect(bash.execute({ command: 'echo err 1>&2; exit 3' }, { cwd: dir })).resolves.toEqual({
      stdout: '',
      stderr: 'err\n',
      exitCode: 3,
    })
  })

  it('命令不存在：bash 的 127 退出码 + stderr 报错，不抛错', async () => {
    const output = (await bash.execute({ command: 'definitely-not-a-command-xyz' }, { cwd: dir })) as {
      stdout: string
      stderr: string
      exitCode: number
    }
    expect(output.exitCode).toBe(127)
    expect(output.stderr).toContain('definitely-not-a-command-xyz')
  })

  it('cwd 生效：相对 ctx.cwd 执行', async () => {
    const output = (await bash.execute({ command: 'pwd' }, { cwd: dir })) as { stdout: string }
    // macOS 上 /var 是 /private/var 的符号链接，shell 的 pwd 输出物理路径，用 realpath 归一。
    expect(await realpath(output.stdout.trim())).toBe(await realpath(dir))
  })

  it('input.cwd 覆盖会话 cwd', async () => {
    const output = (await bash.execute({ command: 'pwd', cwd: '/' }, { cwd: dir })) as { stdout: string }
    expect(output.stdout.trim()).toBe('/')
  })

  it('cwd 不存在：rejection 传播（spawn 失败是真失败）', async () => {
    await expect(
      bash.execute({ command: 'pwd' }, { cwd: resolve(dir, 'no-such-dir') }),
    ).rejects.toThrow()
  })

  it('bashTool 插件把工具注册进 tools 服务（声明带 command/cwd schema）', async () => {
    const { ctx, dispose } = await createTestContext()
    await ctx.plugin(toolRegistry)
    await ctx.plugin(bashTool)
    try {
      const tools = ctx.get('tools')!
      expect(tools.get('bash')).toBeDefined()
      expect(tools.list()).toEqual([
        expect.objectContaining({
          name: 'bash',
          parameters: expect.objectContaining({ required: ['command'] }),
        }),
      ])
    } finally {
      await dispose()
    }
  })
})
