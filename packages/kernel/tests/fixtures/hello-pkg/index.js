// 纯 JS 的 npm 包插件：把 options.message 作为 'hello-greeting' 服务注入。
export default function helloPlugin(ctx, config) {
  const message = config?.message ?? 'hello'
  ctx.provide('hello-greeting', message)
}
