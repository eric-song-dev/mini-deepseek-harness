# mini-deepseek-harness

DeepSeek Harness 的教学迷你实现：**一切皆为插件**（CORDIS 内核），基础 chat + Trajectory 事件轨迹，Web 客户端优先。

> 上游参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 快速开始

```sh
pnpm install
pnpm test        # 全量测试（Vitest）
pnpm typecheck   # 全量类型检查
pnpm demo:kernel packages/kernel/examples/hello-profile/profile.yml  # M0 demo：启动一个 profile
pnpm demo:session  # M1 demo：事件日志落盘 / resume / 崩溃恢复（零 API key）
pnpm demo:agent    # M2 demo：agent loop 三幕（零 API key）
pnpm demo:tools --clean  # M3 demo：假 LLM 台词本驱动真工具（读→改→总结，零 API key）
# 真 API 冒烟（唯一需要 key 的命令；key 放 .env 或环境变量 DEEPSEEK_API_KEY，其余全部零 key）：
pnpm demo:real --ask "用一句话介绍你自己"
```

## 包布局（monorepo）

| 包 | 一句话 |
|---|---|
| `packages/kernel` | 启动器 + profile 加载（`profile.yml` → cordis ctx），唯一"启动"的地方 |
| `packages/session` | 事件词汇 + append-only 日志 + SessionPersistence seam + JSONL 后端（日志是真源） |
| `packages/test-support` | 测试公共语言：测试 ctx、测试服务注入、事件断言、假 LLM |
| `packages/llm` | LLM seam + OpenAI 兼容 adapter（默认 DeepSeek；Ollama/vLLM 通用） |
| `packages/agent` | agent loop：全仓唯一的"拿输入→调模型→写输出"循环，M3 起含工具调用循环 |
| `packages/tools` | Tools seam（注册表 + 执行管线 + approval hook 预留位）+ bash/文件读/写/编辑 |

其余包（web/client/bundle-web/skill）随里程碑逐个出现，见 `docs/requirements.md` §7。

## 文档

- 需求总纲（MVP / backlog / 里程碑 / seams / 教程交付要求）：[docs/requirements.md](docs/requirements.md)
- 里程碑详细 spec：`docs/milestones/M<n>.md`
- 里程碑教程（面向 AI 编程小白，随每个 M 同步产出）：[docs/tutorials/](docs/tutorials/README.md)
- 项目决策与进度记录（跨 session durable memory）：[.agents/notes/](.agents/notes/)

## 开发纪律

- TDD：`.agents/skills/tdd/SKILL.md`（从本项目目录启动的 DSH session 自动发现）
- 当前进度：见 `.agents/notes/README.md` 的状态指针

## 状态

M0（脚手架 + test-support + cordis 最小启动）、M1（Session 事件词汇 + JSONL 持久化 + resume +
崩溃恢复）、M2（LLM seam + 假 LLM + agent loop）、M3（Tools seam + bash/fs 工具 + 工具调用循环）
已完成；M4（Web：RPC 桥 + 会话列表 + composer + 流式 + tool 卡片）待开始。
