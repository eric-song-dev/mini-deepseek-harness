# @mini-dsh/mcp

MCP 客户端桥：连接外部 [Model Context Protocol](https://modelcontextprotocol.io/) server（stdio
transport），把它的工具以 `mcp__<serverName>__<rawName>` 公开名注册进现有 Tools 注册表——之后自动
流入现有执行管线。**MCP 只是"工具生产者"，不是一种新的工具类型；agent loop 一行不改。**

## 为什么是这个 seam

M3 的工具都长在仓库里（bash/文件），M8 的 subagent/workflow 也是进程内插件。这个包回答的是：
**能力从哪来？** 答案是"外部进程"——MCP 生态里有数百个现成 server（GitHub、文件系统、数据库、
搜索……）。桥的职责只有三件事：连接与发现（分页 `listTools`）、注册（`publicToolName` 纯函数命名）、
执行与撤销（rawName 只走 wire；断开即撤销 + dispose 可逆）。它不造独立服务键——一个插件实例 =
一个 MCP server，profile 里 N 行同插件不同 config 就是 N 个 server（上游同款 namespace 插件形态）。

## 用法

```yaml
# profile.yml：一行插件 + 一段配置 = 接入一个外部 MCP server
plugins:
  - name: '@mini-dsh/mcp'
    options:
      serverName: fixture          # ^[A-Za-z0-9_-]{1,32}，跨存活实例唯一
      transport: stdio             # mini 只做 stdio（streamable-http 是裁剪项）
      command: node                # 拉起 server 子进程的命令
      args: ['./fixture-server.mjs']
      # env: {}                    # 覆盖在进程环境之上（mini 不做凭据 scrub——裁剪）
      # cwd: '.'                   # 默认 process.cwd()
```

模型会看到 `mcp__fixture__add`、`mcp__fixture__greet` 等工具，与 bash/subagent 同形态。

## 关键语义

| 事项 | 契约 |
|---|---|
| 命名 | `mcp__<server>__<raw>`；非法字符替换 `_`；超长（>64）**报错**（不截断不 hash——裁剪，碰撞由注册表重名抛错 + 整代回滚兜底） |
| 两阶段同步 | fetch（分页攒新一代，失败不碰注册表）→ swap（先撤销旧代再注册新代，冲突回滚整代）。触发：启动一次 + `notifications/tools/list_changed` 重同步（失败保留旧代） |
| 执行 | executor 闭包持有 rawName（公开名绝不发服务器）；text 块 `\n` 连接、image/audio/resource → 占位符；`isError:true` 是**结果**（`{ isError, content }`），仅 transport 级失败 throw |
| 生命周期 | 初始 connect/同步失败恒 throw（fail-fast）；`onclose`（子进程退出）→ 断开即撤销全部工具；重连 = dispose 后重新装载（公开名是纯函数，重建名字完全相同）；dispose = 注销 + 关连接 + 释放 serverName |
| 注册可逆 | 每个工具注册的撤销函数收进代表；`ctx.effect` 挂 dispose（M6 纪律，HMR-safety 测试守护） |

## 裁剪（相对上游 dsh-mcp-client）

streamable-http transport、自动重连监督器、OAuth/headers、resources/prompts、outputSchema 校验、
`failOnStartupError` 二态（mini 恒 fail-fast）、子进程环境 scrub、公开名 hash 规范化、toolCallTimeoutMs。
取舍理由见 [M9 教程](../../docs/tutorials/M9-mcp.md) §4 与
[上游调研 note](../../.agents/notes/implemented/architecture/2026-08-16-m9-上游调研.md)。

## 教学入口

- 零 key 演示：`pnpm demo:mcp --clean`（三幕：发现 → 真调用入轨迹 → 断开即撤销 + 重装恢复）
- 教程 + 练习：`docs/tutorials/M9-mcp.md`（练习：写一个骰子 MCP server 并接进 mini）
- 测试分层：`tests/config|naming|sync|executor.test.ts`（假 client 纯逻辑）→
  `tests/plugin.test.ts`（mock SDK 生命周期）→ `tests/mcp.e2e.test.ts`（真 stdio：
  fixture server + 官方 server-filesystem 互操作）→ `tests/my-dice.test.ts`（教程练习）
