# @mini-dsh/client —— Client Slot seam + UI 插件

M4 里程碑的客户端包："一切皆为插件"在 UI 层的延续。会话列表、composer、流式消息、
tool 卡片、M5 的**轨迹面板**都是**插件**，各自把 UI 组件注册进 **Slot**（UI 注册点），
client-shell 按 slot 装配成单页。

## 为什么 client 只是"日志的又一个消费者"

浏览器里没有第二份"对话状态"：所有气泡、工具卡片、会话列表，都是从**事件日志投影**来的——
与 host 侧 loop 的模型输入投影（`projectMessages`）是同一个真源的两个消费者。
client 收到的事件（经桥推送）就是日志条目本身（seq/ts/payload 原样）。

## 组成

| 模块 | 是什么 |
|---|---|
| `connection.ts` | `ClientBridge` seam（发请求 + 收事件）+ `wsClientBridge`（浏览器 WebSocket 包装） |
| `slots.ts` | `SlotRegistry`：UI 注册点，**不依赖任何 UI 框架**（值是不透明句柄） |
| `store.ts` | `ClientSessionStore`：client 侧的日志投影缓存（列表/当前会话/忙碌 + 订阅通知） |
| `projection.ts` | 显示投影：日志 → 对话气泡（含流式分片追加）与 tool 卡片（调用/结果配对） |
| `shell.ts` | `clientShell` 插件：提供桥、store、slot 注册表三个服务 |
| `react.tsx` | React 绑定：`ClientRoot` 按 slot 装配单页（"第一个渲染实现"） |
| `ui/*.tsx` | UI 插件：会话列表 / 对话区（流式气泡 + composer）/ 工具卡片 / **轨迹面板（M5）** |

## 关键设计

- **UI 插件只认可注入的 client 连接**，不认 WebSocket：测试用内存直连（零网络），
  生产用 `wsClientBridge`——两个实现后面是同一个 `ClientBridge` seam。
- **Slot 注册表不依赖 React**：未来换渲染框架只换装配层（`react.tsx`），
  插件与服务不动；未列入主布局的 slot 自动进 extras 区——加 ui 插件不改 shell。
- **流式分片也是日志事件**（`assistant/stream`）：气泡逐分片追加（打字机），
  `assistant` 终事件封印成全文；非流式实现只有终事件，天然兼容。
- **轨迹面板（M5）走同一个 Slot 机制**：注册 slot `trajectory` → extras 区全宽面板
  （按轮事件表 + 点选检查器），shell 与 entry 一行不改——"未来任意 ui-* 插件从 Slot
  挂进来"的第一次兑现。它消费 session 包的 `projectTurns`（同一份日志的又一个投影）。

## 怎么测试

```sh
pnpm vitest run --project dom   # jsdom workspace（与 node 侧分开跑，互不污染）
```

`tests/ui.test.tsx` 用**真 host（内存桥）+ 假 LLM + jsdom 渲染**跑完整对话流：
新建会话 → 发消息 → 流式气泡 → tool 卡片——这是"浏览器里完成一次真实对话"的自动化替身
（人工浏览器验收交给 `pnpm demo:web:fake`（零 key）与教程练习）。
`tests/trajectory.test.tsx`（M5）同款链路跑轨迹回放：轮表/事件明细/检查器/token 兜底。

## 注册可逆（M6）

订阅链（store → bridge → transport）的清理归 **clientShell（装配者）**：卸载时
`store.dispose()` 退订事件 + `bridge.close()` 关连接（`tests/shell.test.ts` 守护）。
`SlotRegistry.register` 返回幂等撤销函数，ui 插件经 `registerSlot` 助手挂
`ctx.effect`——卸载 ui 插件即撤销 slot（`tests/ui-reversibility.test.ts` 守护）。
`createBridgeClient.close()` 幂等：拒绝未决请求、清空订阅、摘除 transport 监听器。
