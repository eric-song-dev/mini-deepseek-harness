---
name: doc-standards
description: 在 mini-deepseek-harness 仓库写作、移动、审查或审计文档时使用——决定层级与详略、区分教程与参考、检查教程递进、修剪文档脂肪，或回应"改进文档""审计文档""这段该写在哪里""这篇太长"之类的请求。
---

# 应用 mini-deepseek-harness 文档标准

文档规则的总纲在 [docs/requirements.md](../../docs/requirements.md)（§5.1 教程交付、§10 DoD、§11 开发纪律）。本工作流覆盖放置、语料审计与校验。它是引导，不是脚本；措辞的覆盖要求与编辑判断用 [prose-standard](../prose-standard/SKILL.md)，绝不要把长度本身当缺陷。

## 事实来源（先读，不要重新总结）

- [docs/requirements.md](../../docs/requirements.md) —— 教程六要素（动机/design/新概念/tradeoff/stepbystep/练习）与"小白验收"（零 API key 可跟做）、DoD。
- [.agents/notes/README.md](../../.agents/notes/README.md) —— 什么决策配得上一份 note、怎么归档、四目录（proposed/implemented/rejected/archived）各自装什么。
- [docs/tutorials/README.md](../../docs/tutorials/README.md) —— 教程目录索引（每篇注册在案）。
- [docs/milestones/](../../docs/milestones/) —— 每个里程碑的详细 spec（任务拆解与验收）。

## 先看结构，再看措辞

对范围内每份面向人的文档应用标准顺序（Agent Notes 不做这个结构检查）：

1. 定位文档在仓库与导航树里的位置。陈述它自己的主题、指出它的直接子文档。
2. 设定允许的详略。主题本身保留全细节；子文档按用途、职责、高层行为总结，更深的解释移到拥有它们的后代并用链接。
3. 按**用途**分类，不按路径或标题。教程必须领着读者按顺序做完工作、到达可观察的结果；参考必须支持在显式范围内的查找，不要求顺序阅读。
4. 教程要私下分类起点读者与概念（入门/中级/高级）。把每个概念追溯到前置概念，重排过早出现的材料，可选的进阶细节移到后面的教程或参考。
5. 混合形式明显时拆开：小的次要形式放进一个明确标注的小节。

再查让放置变贵或变错的约束：

- 教程里的命令与代码块是"小白验收"的对象——改代码就要同步教程练习（`pnpm tsx <练习>` / `vitest run <练习测试>` 必须仍然可复制即跑）。
- 生成物（如文档里的目录表）不要手编；事实属于哪里就改哪里的源。
- 移动或改名前 grep 入链引用：`grep -rn "旧路径" docs packages .agents`；一次移动要原子完成——旧家删除、新家新增、同一次变更修好所有入链。
- 教程与 spec 的对应：`docs/milestones/M<n>.md` 的"教程主题"表登记了每篇教程的 slug，requirements §9 有教程落点表——新教程要两边登记。

## 审计语料

结构化检查之后，用最便宜的探针先猎脂肪清单。先确认变更范围（`git status` + `git diff <base>`），再应用语义判断。

1. 度量：`git ls-files '*.md' | xargs wc -l | sort -rn | head -30` 找出没有预算约束的离群文件。
2. 用 [trim-cot-leakage](../trim-cot-leakage/SKILL.md) 猎推理过程泄漏——叙事历史、死设计会话引证、审查编排、控制流叙事、测试走查。只保留非显然契约或持久理由；同一条理由在兄弟方法旁重复时留一个家。
3. 用 grep 独特短语猎重复。留一个家，其余替换为链接。
4. 手编的目录、测试/状态清单、JSDoc 复述换成权威的树、脚本或生成引用。
5. `implemented/` 里的 notes：删迁移计划、验收任务清单与未来时态 spec 语言。保留识别"哪些行为与层级钉住了这个已交付决策"的简洁验证契约，加上指名覆盖缺口。
6. 删文字如果改变的是被承诺的行为而不是它的解释，先用一份 proposed note（跟 [archive-agent-notes](../archive-agent-notes/SKILL.md) 的归档纪律走）。

`.agents/notes/archived/` 排除在语料审计与编辑之外。活跃文字可以修复、改指或删除入链，但绝不跟着全库清理闯进冻结目标。

每条承重规则保留，最好一到三行加一个理由链接。砍故事、重复、状态笔记与推导过程。不要为了给一次性推理搬家而新建解释。

## 教程六要素核对（本仓库特有）

每篇教程（§5.1）逐条核对：动机（为什么排在这个顺序、与前一个 M 的关系）→ design（做了什么设计，必要时配 plantUML 图）→ 新概念（每个首次出现的概念都解释）→ tradeoff（关键取舍与理由）→ stepbystep（从头到尾看代码的顺序）→ 动手练习（可跟做、可运行）。验收 = 零 API key 可跟做。

## 验证与卫生

至少跑：受影响的教程练习、`pnpm typecheck`、`git diff --check`。报告字行增量、解释任何故意偏长的例外、列出跑过的检查。
