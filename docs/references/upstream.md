# 上游参考指引（deepseek-ai/deepseek-harness）

"参照 deepseek-ai/deepseek-harness" 的具体执行协议。**按下面的优先级查阅，不要凭印象写、不要全量读仓库。**

## 查阅优先级

| 优先级 | 来源 | 何时用 |
|---|---|---|
| 1 | 本地克隆的上游源码（建议一次克隆到**本项目仓库外**）：`git clone --depth 1 git@github.com:deepseek-ai/deepseek-harness.git ../deepseek-harness-upstream` | 实现某 seam 前读原版对应 README（离线、可 grep） 我已安装好，不必安装 |
| 2 | 本地已安装的 `@deepseek-ai/dsh`（**真实运行中的 harness**）：`/Users/ericsong/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh/`，含 `bin.js`、`lib/`、`config/agent-presets/{code,cordis,minimal,standard}/`（preset 的 `agent.cordis.yml` + `preset.yml` 是组合的最佳实例） | 看 CLI 行为、看真实 profile 组合长什么样 |
| 3 | GitHub 在线（默认分支 `master`）：列目录 `curl -sL https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/<path>`；读文件 `curl -sL https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/<path>` | 本地克隆不可用时按需 fetch 单文件 |
| 4 | DeepWiki（`https://deepwiki.com/deepseek-ai/deepseek-harness`）+ web_search | 概念性问题、找不到文件时兜底 |

## 关键路径索引（按需读，一次只读一个文件）

- 总体架构：`docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/glossary.zh.md`
- 核心 loop（全仓唯一具体循环逻辑）：`packages/core/agent-loop/README.md`、`packages/core/agent/README.md`
- Session/轨迹：`packages/core/session/README.md`、`docs/subsystems/session.zh.md`、`docs/subsystems/persistence.zh.md`、`packages/session/session-persistence-jsonl/README.md`
- 工具：`docs/subsystems/tools.zh.md`、`docs/tool-execution-pipeline.zh.md`
- LLM：`packages/llm/`、`docs/subsystems/llm-streaming.zh.md`
- Skills：`docs/subsystems/skills.zh.md`、`packages/skill/README.md`
- Web：`docs/subsystems/web-server.zh.md`、`packages/web/`、`packages/client/README.md`、`packages/client/web/`
- Trajectory 视图：`packages/client/ui-trajectory/README.zh.md`
- 组合（bundle/profile）：`packages/bundle/{base,web-app}/`、`config/agent-presets/*/agent.cordis.yml`（本地安装）
- CLI 客户端：`apps/cli/`（backlog 时再读）

## 使用纪律

1. **照搬概念，不照搬代码**：原版规模远大于 mini，直接抄会失控；先读原版 README 的"Service / 配置 / 已知限制"章节，提取 seam 契约与命名，再在 mini 里写自己的实现。
2. **一次只读一个文件**，读完立刻记录关键契约到本 M 的 notes；不要抓取整个仓库。
3. 本地安装的 launcher 与上游源码可能版本不同步，冲突时以 ../deepseek-harness-upstream 为准（注意记录差异到 notes）。
