# @mini-dsh/skill

**Skills 子系统（M5；M7 升级为原版 SKILL.md 格式契约）**：agent 的"可检索知识"从哪来，
以及模型怎么**按需**取到它。

## 为什么有这个包

前四个里程碑做完了"日志真源 → 投影"的原料与通道，但 agent 仍然只会用 bash/文件工具
（M3）。**skill 是给 agent 的"说明书"**：一段 Markdown 正文（SKILL.md）描述"怎么做好
某件事"（比如本仓库自己的 `.agents/skills/tdd/SKILL.md`）。mini 版的自举验收就是：
它能加载并运行自己项目的 TDD skill —— 教学系统"教自己"，这是 M5 的浪漫闭环。
M7 落地了原版的 **SKILL.md 格式契约**（frontmatter：`name` kebab-case + `description`
必填、可选 `whenToUse` / `disable-model-invocation` / `user-invocable`；fail-closed
校验），并移植了 6 个上游技能（`code-review`、`prose-standard`、
`trim-cot-leakage`、`pre-push-checks`、`doc-standards`、`archive-agent-notes`）。

## 三个部分

| 模块 | 是什么 | 为什么 |
|---|---|---|
| `Skills` seam | `register / list / get` 的抽象服务 | 换技能来源（远程市场、bundled）只换提供 `skills` 服务的插件，消费方一行不改 |
| filesystem 发现 | 扫描 `<dir>/<name>/SKILL.md`，解析 frontmatter 校验（name 与目录名一致），content 只含正文 | 最简单的来源：本地目录约定；坏条目 fail-closed（抛错，绝不默认放行） |
| `skill` 工具 | tools seam 里的普通工具：`list` 列 {name, description} 目录、`get` 取全文 | **文档检索，不是 prompt 拼接**：不把全部技能塞进 system prompt（上下文成本），让模型自己按 description 决定何时需要 |

## 关键语义（"输出是内容，异常是结果"）

- 正常路径返回**内容**：`{ skills: [{name, description}] }` 目录（只含 modelInvocable
  技能，description 空白折叠并截断 500）/ `{ name, description, content }` 全文；
- 模型侧的"异常"（未知技能、坏参数、非 kebab 名、不可调用技能）返回 `{ error: ... }`
  **结果**——模型能看到失败原因并纠正（同 M3 bash 的"exit code 是输出不是异常"），
  而不是把整轮炸掉；
- seam 本身对程序调用方是**响亮**的：`get` 未知技能抛 `UnknownSkillError`、register
  坏技能抛 `InvalidSkillError`（契约测试守护）。

## frontmatter 契约（M7）

`<name>/SKILL.md` 必须带 YAML frontmatter：`name`（kebab-case，与目录名一致）+
`description`（目录只展示它）必填；`whenToUse` 可选；`disable-model-invocation` /
`user-invocable` 是调用策略（宽松布尔：`true/false/yes/no/on/off/1/0`，省略默认允许）。
驼峰 legacy 键、非布尔调用值、坏 YAML、name 不符 → `InvalidSkillError`（fail-closed，
绝不静默放行）。`content` 只返回 frontmatter 之后的正文。教程：
`docs/tutorials/M7-upstream-skills.md`。

## 使用

```ts
// 1. 来源：扫描目录发现技能（不存在的目录视为"没有技能"，照常启动）
await ctx.plugin(skillsFromDirectory, { dir: '.agents/skills' })
// 2. 工具：注册进 tools seam（loop 一行不改，声明走协议 tools 参数）
await ctx.plugin(skillTool)
```

也可以不用文件：`ctx.plugin(provideSkills, registry)` 注入任意实现。

## 测试

- `tests/contracts/skills-contract.ts`：seam 契约套件（任何实现都必须通过）；
- `tests/frontmatter.test.ts`：frontmatter 解析契约（首行/闭合/坏 YAML/name 校验/
  legacy 键/宽松布尔/内容剥离）；
- `tests/fs-discovery.test.ts`：目录约定与边界（不存在 → 空、坏目录 → 报错、跳过非
  skill、坏条目 fail-closed）；
- `tests/tool.test.ts`：工具语义（目录展示/过滤/截断/校验链）；
- `tests/bootstrap.e2e.test.ts`：**自举 e2e**——真 host + 真文件系统 + 假 LLM 台词
  （list 看 7 技能目录 → get tdd / 按 description 路由 get trim-cot-leakage），断言
  模型收到的正文 == 文件 frontmatter 之后的正文。

## 注册可逆（M6）

`SkillsService.register` 返回幂等撤销函数；`skillTool` 对 tools seam 的注册经
`ctx.effect` 挂接——卸载 `skillTool` 插件即从模型可见面摘除 skill 工具
（守护测试 `tests/reversibility.test.ts`）。`skillsFromDirectory` 的注册表由插件
自建并经 `ctx.provide` 提供，插件卸载时整体随服务消亡。
