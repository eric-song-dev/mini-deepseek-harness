import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoadProfileError, loadProfile, parseProfile, startProfile } from '@mini-dsh/kernel'

const fixtureDir = resolve(import.meta.dirname, 'fixtures')
const profile = (name: string) => resolve(fixtureDir, `${name}.yml`)

describe('parseProfile', () => {
  it('把 yaml 解析成 plugins 列表与 options', () => {
    const parsed = parseProfile('plugins:\n  - name: a\n    options:\n      x: 1\n')
    expect(parsed.plugins).toEqual([{ name: 'a', options: { x: 1 } }])
  })

  it('没有 plugins 键视为空 profile', () => {
    expect(parseProfile('# 仅注释\n').plugins).toEqual([])
  })

  it('非法 yaml 抛 LoadProfileError', () => {
    expect(() => parseProfile('plugins: [\n')).toThrow(LoadProfileError)
  })

  it('插件行缺少 name 抛 LoadProfileError', () => {
    expect(() => parseProfile('plugins:\n  - options: {}\n')).toThrow(/第 1 行/)
  })

  it('plugins 不是列表抛 LoadProfileError', () => {
    expect(() => parseProfile('plugins: hello\n')).toThrow(LoadProfileError)
  })
})

describe('loadProfile', () => {
  it('空 profile 能启动，dispose 正常关闭', async () => {
    const { ctx, dispose } = await loadProfile(profile('empty'))
    expect(ctx.registry).toBeDefined()
    await expect(dispose()).resolves.toBeUndefined()
  })

  it('没有 plugins 键的 profile 也能启动', async () => {
    const { dispose } = await loadProfile(profile('minimal'))
    await dispose()
  })

  it('带本地插件行的 profile 启动后服务可注入，options 传给插件 config', async () => {
    const { ctx, dispose } = await loadProfile(profile('with-options'))
    expect(ctx.get('greeting', true)).toBe('bonjour')
    await dispose()
  })

  it('插件行相对路径相对 profile 所在目录解析', async () => {
    const { ctx, dispose } = await loadProfile(profile('subdir'))
    expect(ctx.get('deep-greeting', true)).toBe('from-nested')
    await dispose()
  })

  it('裸包名插件行（npm 包）能装载', async () => {
    const { ctx, dispose } = await loadProfile(profile('bare-package'))
    expect(ctx.get('hello-greeting', true)).toBe('ciao')
    await dispose()
  })

  it('profile 文件不存在抛 LoadProfileError 且消息含路径', async () => {
    await expect(loadProfile(profile('no-such'))).rejects.toThrow(LoadProfileError)
    await expect(loadProfile(profile('no-such'))).rejects.toThrow(/no-such\.yml/)
  })

  it('插件模块不存在抛 LoadProfileError 且消息含行信息', async () => {
    await expect(loadProfile(profile('missing-plugin'))).rejects.toThrow(/does-not-exist/)
  })

  it('插件模块没有 default/apply 导出抛 LoadProfileError', async () => {
    await expect(loadProfile(profile('no-export'))).rejects.toThrow(/没有导出插件/)
  })

  it('非法 yaml 的 profile 抛 LoadProfileError', async () => {
    await expect(loadProfile(profile('bad-yaml'))).rejects.toThrow(LoadProfileError)
  })

  it('插件行缺少 name 抛 LoadProfileError', async () => {
    await expect(loadProfile(profile('missing-name'))).rejects.toThrow(LoadProfileError)
  })
})

describe('startProfile', () => {
  it('启动时发 app/ready，stop 时发 app/stop 并执行插件 effect 清理', async () => {
    const { lifecycleEvents } = await import('./fixtures/plugins/lifecycle')
    lifecycleEvents().length = 0

    const running = await startProfile(profile('lifecycle'))
    await running.stop()

    expect(lifecycleEvents()).toEqual(['ready', 'stop', 'cleaned'])
  })

  it('setup 钩子在 app/ready 之前对 ctx 执行（供挂载 logger 输出等）', async () => {
    const { lifecycleEvents } = await import('./fixtures/plugins/lifecycle')
    lifecycleEvents().length = 0

    const running = await startProfile(profile('lifecycle'), {
      setup: () => {
        lifecycleEvents().push('setup')
      },
    })
    await running.stop()

    expect(lifecycleEvents()).toEqual(['setup', 'ready', 'stop', 'cleaned'])
  })
})
