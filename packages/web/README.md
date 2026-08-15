# @mini-dsh/web —— host 服务：RPC 桥 + HTTP/WS

M4 里程碑的核心包：把 M1–M3 攒下的能力（会话、loop、工具）从 `console.log` 的演示对象
变成**远程操作**，让浏览器里的人能真正用起来。

## 为什么需要这个包

M3 结束时，agent 已经"会说也会做"，但只活在 Node 进程里：demo 打印事件日志，只有开发者看得见。
要让 Web 客户端消费同一套东西，host 必须把自己的能力暴露成远程操作——
这就是 **RPC 桥**：client 发请求（带 requestId），host 回响应（requestId 配对）；
会话事件则从 host **推送**给 client（唯一实时通道）。

## 组成

| 模块 | 是什么 | 为什么是 seam |
|---|---|---|
| `protocol.ts` | host↔client 消息协议（request/response/event） | 桥两端共享的契约，只依赖 session 的 `SessionEvent` |
| `bridge.ts` | `RpcBridge` seam：连接管理 + 请求分发 + 事件推送 | UI 与 host 逻辑只认这套契约，不认 WebSocket |
| `ws-server.ts` | 生产传输：WebSocketServer → `BridgeConnection` | 传输只是"JSON 文本 ↔ 消息对象"，桥不知道它存在 |
| `host.ts` | `webHost` 插件：SessionManager 门面 RPC + 静态文件 + WS 升级 | 换持久化后端/换 LLM 只是换注入的插件，host 零改动 |

## 关键设计

- **WebSocket 是唯一实时通道**：HTTP 只做静态文件 + 升级握手。RPC 最小集：
  `session.list` / `session.create` / `session.resume` / `session.send`。
- **桥是 seam**：测试用内存直连（`memoryConnectionPair`，同进程零网络），
  client 组件测试因此完全不需要起真服务器。
- **loop 与桥靠"事件 + 服务入口"对接**：会话 ctx 上挂桥接适配插件，监听
  `session/append`（日志每追加一条同步发出）→ 桥推送。loop 本体一行不改。
- **会话常驻**：host 里的会话表即内存会话表 + 磁盘元数据；resume 幂等，
  返回 `{ meta, events }` 完整历史，client 重连即恢复。

## 怎么测试

```sh
pnpm vitest run packages/web
```

- `bridge.test.ts`：桥契约（requestId 配对、事件保序、坏载荷/未知方法错误、断线清理）。
- `ws-server.test.ts`：真 WebSocket 传输遵守同一契约。
- `host.test.ts`：门面 RPC + 静态文件（目录穿越防护）+ 注入内存桥的零网络测试面。
- `e2e.test.ts`：真 HTTP+WS host + 脚本化 WS 客户端全链路（含断线重连 resume）。

## 试一下

```sh
pnpm demo:web   # 起真 host（假 LLM 台词本），浏览器打开完成一次"真实对话"
```
