// profile 演示用 shim：把 @mini-dsh/tools 的具名插件包装成 default 导出，
// 使 profile.yml 一行即可装载（loadProfile 只认 default / apply 导出）。
export { toolRegistry as default } from '@mini-dsh/tools'
