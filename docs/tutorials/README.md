# 里程碑教程索引

面向 **AI 编程小白**的入门教程，随每个里程碑（M）与代码同步交付。读者只需要会基础 TypeScript
和命令行；每篇教程都从零解释新概念、给出可跟做的练习，且**不需要任何 API key**。

| 里程碑 | 教程 | 一句话主题 |
|---|---|---|
| M0 | [M0-kernel-and-plugins.md](M0-kernel-and-plugins.md) | 什么是 CORDIS：ctx、服务、事件、插件、profile 组合 |
| M1 | [M1-event-log.md](M1-event-log.md) | 事件日志与真源：为什么 append-only、崩溃恢复 |
| M2 | [M2-llm-and-loop.md](M2-llm-and-loop.md) | seam 与假 LLM：agent loop 怎么驱动会话 |
| M3 | [M3-tools.md](M3-tools.md) | 工具注册与执行：工具事件如何进轨迹、loop 怎么循环调用 |
| M4 | [M4-web.md](M4-web.md) | host↔client 桥：流式消息怎么到浏览器、Slot 怎么装配 UI |
| M5 | [M5-trajectory-and-skills.md](M5-trajectory-and-skills.md) | 投影视图与 skills：轨迹灵魂的最后一环 |
| M6 | [M6-reversible-registrations.md](M6-reversible-registrations.md) | 注册与撤销：effect 生命周期、HMR-safety、订阅清理 |
| M7 | [M7-upstream-skills.md](M7-upstream-skills.md) | 原版技能体系：SKILL.md 格式契约、frontmatter 解析、fail-closed、mini 化改写 |
| M8 | [M8-subagent-workflow.md](M8-subagent-workflow.md) | 多智能体：子代理怎么派生（spawn/fork）、结果怎么回收、workflow 脚本钩子怎么编排 |
| M9 | [M9-mcp.md](M9-mcp.md) | 外部工具协议：MCP server 的工具怎么变成本地 Tools 注册表的一员、两阶段同步、断开即撤销 |

每篇的验收标准（requirements §5.1"小白验收"）：**零 API key 可跟做**——练习全部由假 LLM / 测试
脚手架驱动；教程中的命令与代码块复制即跑。

> 教程是文档，不适用 TDD 红绿循环，但属于对应里程碑的验收项（requirements §10）。
