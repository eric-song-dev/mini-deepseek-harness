# mini-deepseek-harness

DeepSeek Harness 的教学迷你实现：**一切皆为插件**（CORDIS 内核），基础 chat + Trajectory 事件轨迹，Web 客户端优先。

> 上游参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 快速开始

```sh
pnpm install
pnpm test        # 全量测试（Vitest）
pnpm typecheck   # 全量类型检查
pnpm demo:kernel packages/kernel/examples/hello-profile/profile.yml  # M0 demo：启动一个 profile
```

## 包布局（monorepo）

| 包 | 一句话 |
|---|---|
| `packages/kernel` | 启动器 + profile 加载（`profile.yml` → cordis ctx），唯一"启动"的地方 |
| `packages/test-support` | 测试公共语言：测试 ctx、测试服务注入、事件断言 |

其余包随里程碑逐个出现，见 `docs/requirements.md` §7。

## 文档

- 需求总纲（MVP / backlog / 里程碑 / seams / 教程交付要求）：[docs/requirements.md](docs/requirements.md)
- 里程碑详细 spec：`docs/milestones/M<n>.md`
- 里程碑教程（面向 AI 编程小白，随每个 M 同步产出）：[docs/tutorials/](docs/tutorials/README.md)
- 项目决策与进度记录（跨 session durable memory）：[.agents/notes/](.agents/notes/)

## 开发纪律

- TDD：`.agents/skills/tdd/SKILL.md`（从本项目目录启动的 DSH session 自动发现）
- 当前进度：见 `.agents/notes/README.md` 的状态指针

## 状态

M0（脚手架 + test-support + cordis 最小启动）已完成；M1（Session 事件词汇 + 持久化）待开始。
