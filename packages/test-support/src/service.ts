import type { Context, Plugin } from 'cordis'

/**
 * 把一个任意对象作为命名服务注入测试 ctx。
 * 装载后可通过 `ctx.get(name)` 取到；声明 `inject: [name]` 的插件可通过 `ctx.<name>` 取到。
 *
 * 这是 cordis "一切皆为插件"的最小演示：连测试服务都走插件装载。
 */
export function defineTestService<T>(name: string, service: T): Plugin.Function {
  return function (ctx: Context) {
    ctx.provide(name, service)
  }
}
