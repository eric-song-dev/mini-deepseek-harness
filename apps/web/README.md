# apps/web —— Web 客户端壳（Vite entry）

**只注入，不是独立应用。** 这里没有业务逻辑：

- `src/main.tsx`：拼 WebSocket 桥地址 → 装载 `@mini-dsh/bundle-web` 的 `webBundle`
  → 渲染 `@mini-dsh/client` 的 `ClientRoot`。共约 30 行。
- `src/style.css`：三栏布局与气泡样式（壳的皮）。
- `index.html` + `vite.config.ts`：Vite 把壳打包成静态产物。

真正的应用在插件里（client-shell + 首批 UI 插件，见 `packages/bundle-web` 与
`packages/client`）；本包不是独立应用——产物由 `packages/web` 的 host 服务
（`pnpm demo:web:fake`，零 key；或 `pnpm demo:web` 用真模型），它自己没有任何服务端能力。

## 命令

```sh
pnpm --filter @mini-dsh/app-web build   # 产出 dist/（根脚本 build:web）
pnpm demo:web:fake                      # 构建 + 起 host + 打开页面（假 LLM 台词本，零 key）
```

## 测试

```sh
pnpm vitest run apps/web   # 构建冒烟：vite build 成功 + 产物含 index.html 与 JS 入口
```
