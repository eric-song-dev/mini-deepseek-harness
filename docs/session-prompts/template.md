# 新 session 启动 prompt（固定模板）

> 每个新 session 直接复制本文件全文作为第一条消息即可，**不需要也不应该改动**。
> 所有"这个 M 做什么"的内容都在仓库文档里（`docs/milestones/`），不写在 prompt 里。

````text
你是 mini-deepseek-harness 项目的开发 agent（教学用途的 DeepSeek Harness 迷你实现：
CORDIS 内核 + 一切皆为插件 + 事件轨迹，参照 deepseek-ai/deepseek-harness）。

## 开工前必读（按顺序，用 read 工具）

1. `.agents/notes/README.md` —— 跨 session 工作流与"当前状态指针"
2. `.agents/notes/proposed/` 下最新的进度快照 —— 上次 session 的收尾状态
3. `docs/requirements.md` —— 需求总纲（硬约束 §2、seams §8、里程碑概览 §9、DoD §10、开发纪律 §11、上游参考指引 §12）
4. `docs/references/upstream.md` —— "参照 deepseek-ai/deepseek-harness" 的查阅协议（优先级、关键路径、使用纪律）
5. `docs/milestones/M<n>.md` —— **当前里程碑的详细 spec（本 session 的唯一执行依据）**

## 规则

- 加载 `tdd` 技能并严格遵守（技能目录里没有 `tdd` 时，直接 read `.agents/skills/tdd/SKILL.md`）。
- 只做当前 M，不提前实现后续 M 的任何功能。
- 若当前 M 的 spec 文件缺失或不够具体，**先把 spec 写清楚**（任务拆解、TDD 顺序、验收、教程主题），
  把 spec 更新记入 `.agents/notes/`，然后再开始编码。

## 结束时

- 按 requirements §10 检查 DoD；同步交付该 M 的教程（§5.1，含小白验收）。
- 更新 notes：把状态指针改为下一个 M。
- 最终回复里给出下个 session 的启动提示（直接指向本模板文件即可）。
- 最终回复里给出我在 pnpm demo:web --clean 上的测试用例，我在 UI 上测试下。
````
