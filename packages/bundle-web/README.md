# @mini-dsh/bundle-web —— web profile 组合

把 client 侧插件按序叠加成浏览器可跑的应用——与 host 侧 profile 同构的
"一切皆为插件"组合层：

```ts
await ctx.plugin(webBundle, { bridge }) // clientShell + 会话列表 + 对话区 + 工具卡片
```

`webBundle` 只做一件事：按顺序装载 `clientShell` 与首批 UI 插件。
加面板（比如 M5 之后的 ui-trajectory）= 在这里加一行，shell 与 entry 一行不改。

## 为什么需要单独的 bundle 包

apps/web 只是 **Vite entry 壳**（只注入，不是独立应用）：它拼一个 WebSocket 地址、
装载 `webBundle`、渲染 `ClientRoot`。真正的组合逻辑在这个包里——
这样"用哪些插件组成应用"是可见的、可测试的（见 `tests/bundle.test.ts`），
未来换组合（比如去掉 tool 面板的精简版）只换这一行。

## 测试

```sh
pnpm vitest run packages/bundle-web
```

`tests/bundle.test.ts`：装载后 clientShell 三服务就绪、三个首批 UI 面板注册进各自 slot。
