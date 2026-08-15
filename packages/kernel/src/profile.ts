import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context } from 'cordis'
import type { Plugin } from 'cordis'
import { parse as parseYaml } from 'yaml'

export interface ProfilePluginEntry {
  /** 插件模块：npm 包名，或相对/绝对路径（相对路径相对 profile 文件所在目录）。 */
  name: string
  /** 可选配置，原样传给插件函数的 config 参数。 */
  options?: unknown
}

export interface Profile {
  plugins: ProfilePluginEntry[]
}

export interface LoadedProfile {
  ctx: Context
  /** 卸载全部插件并关闭 ctx。 */
  dispose: () => Promise<void>
}

/** profile 读取、解析、装载过程中的所有错误。 */
export class LoadProfileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LoadProfileError'
  }
}

/** 把 profile 的 yaml 源文本解析为 Profile（含最小校验）。 */
export function parseProfile(source: string): Profile {
  let data: unknown
  try {
    data = parseYaml(source)
  } catch (cause) {
    throw new LoadProfileError('profile 不是合法的 yaml', { cause })
  }
  if (data === null || data === undefined) {
    // 空文件/空文档也是合法的空 profile
    return { plugins: [] }
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new LoadProfileError('profile 顶层必须是对象')
  }
  const rawPlugins = (data as Record<string, unknown>).plugins
  if (rawPlugins === undefined) {
    return { plugins: [] }
  }
  if (!Array.isArray(rawPlugins)) {
    throw new LoadProfileError('plugins 必须是列表')
  }
  const plugins = rawPlugins.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new LoadProfileError(`plugins 第 ${index + 1} 行必须是对象`)
    }
    const { name, options } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name.length === 0) {
      throw new LoadProfileError(`plugins 第 ${index + 1} 行缺少字符串 name`)
    }
    return options === undefined ? { name } : { name, options }
  })
  return { plugins }
}

/**
 * 读取并装载一个 profile：逐行 import 插件模块 → 用 cordis 组装 ctx。
 * 每行失败都会抛 LoadProfileError（消息含行号与模块名）。
 */
export async function loadProfile(profilePath: string): Promise<LoadedProfile> {
  let source: string
  try {
    source = await readFile(profilePath, 'utf8')
  } catch (cause) {
    throw new LoadProfileError(`无法读取 profile 文件: ${profilePath}`, { cause })
  }
  const profile = parseProfile(source)
  const ctx = new Context()
  const baseDir = dirname(profilePath)
  for (const [index, entry] of profile.plugins.entries()) {
    const specifier = resolveSpecifier(entry.name, baseDir)
    let mod: Record<string, unknown>
    try {
      mod = (await import(specifier)) as Record<string, unknown>
    } catch (cause) {
      throw new LoadProfileError(`plugins 第 ${index + 1} 行（${entry.name}）模块加载失败: ${specifier}`, {
        cause,
      })
    }
    const plugin = (typeof mod.default === 'function' ? mod.default : mod.apply) as
      | Plugin
      | undefined
    if (typeof plugin !== 'function') {
      throw new LoadProfileError(
        `plugins 第 ${index + 1} 行（${entry.name}）没有导出插件（需要 default 或 apply）`,
      )
    }
    try {
      await ctx.plugin(plugin as Plugin.Function, entry.options)
    } catch (cause) {
      throw new LoadProfileError(`plugins 第 ${index + 1} 行（${entry.name}）装载失败`, { cause })
    }
  }
  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}

/** './x'、'../x'、绝对路径 → 相对 profile 目录解析；其余视为 npm 包名。 */
function resolveSpecifier(name: string, baseDir: string): string {
  if (name.startsWith('./') || name.startsWith('../') || isAbsolute(name)) {
    return resolve(baseDir, name)
  }
  return name
}
