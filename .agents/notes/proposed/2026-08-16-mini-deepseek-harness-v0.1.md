# 需求定稿：mini-deepseek-harness v0.1

- **日期**：2026-08-16
- **状态**：`proposed`（需求定稿；M0–M5 全部完成，MVP 10 项收口，进入 backlog 排期）

## 背景

用户（eric-song-dev）要在本仓库实现一个教学用途的 DeepSeek Harness 迷你版：保留 CORDIS 内核与"一切皆为插件"哲学，实现基础 chat、保留 Trajectory（灵魂），Web 客户端优先、CLI 放 backlog，且要为原版全部功能预留扩展接口。

## 决策（本 session 讨论 + 用户拍板）

1. **内核**：TypeScript + pnpm monorepo，使用官方 `cordis` 包（不手写内核）。
2. **LLM**：单一 DeepSeek API 兼容 adapter（即 OpenAI 兼容协议；Ollama/vLLM 等端点通用），seam 预留多 provider。
3. **Trajectory MVP**：简化版 —— 按轮分组事件表 + 点选检查器（token/耗时/输入输出）；虚拟滚动与时间线概览放 v2。
4. **MVP 工具**：bash + 文件读/写/编辑；无审批栈（执行管线预留 approval hook）。
5. **TDD skill**：项目内 `.agents/skills/tdd/SKILL.md`（已创建，本 session 技能目录已热更新生效）。
6. **客户端**：Web 为 P0；CLI（interactive TUI + headless）在 backlog 首位。

## 影响

- 总纲：`docs/requirements.md`（v0.1）——MVP 10 项、backlog 12 项、seams 清单、M0–M5 里程碑。
- 包布局：`@mini-dsh/*`，布局见总纲 §7。
- 开发纪律：TDD（见 skill）+ notes 工作流（本目录）。

## 增补（2026-08-16，用户确认）

7. **教程同步交付**：每完成一个里程碑 M，同步写出该 M 的入门教程（面向 AI 编程小白：动机、新概念解释、tradeoff、可跟做练习；零 API key 可跑），放 `docs/tutorials/M<n>-<slug>.md`。总纲新增 §5.1，DoD 与 TDD skill 检查清单同步更新。原 backlog 第 12 项改为"压轴教程：写你的第一个插件"综合实战篇。

8. **文档单一真源，prompt 固定化**：每个 M 的详细执行 spec 归入 `docs/milestones/M<n>.md`（M0 已定稿），requirements §9 只留概览；新 session 启动 prompt 用固定模板 `docs/session-prompts/template.md`，不再把 M 的细节写进 prompt。

## 下一步（下个 session 起）

- MVP 已全部完成。backlog 排期（requirements §6）：CLI（#1）/ 审批栈（#2）/
  Trajectory v2（#3）/ SQLite 后端（#4）/ subagent（#5）/ MCP-LSP（#6）/
  goal-plan-todo（#7）/ compaction（#8）/ settings-i18n（#9）/ telemetry（#10）/
  动态插件热加载（#11）/ 压轴教程"写你的第一个插件"（#12，收官独立项）。
- 每个 backlog 项的启动方式同里程碑：先定稿 `docs/milestones/` 下的 spec 再编码。

## post-MVP 增补（2026-08-16）：demo:web:real + 演示注入当前时间

- **动机**：用户实测发现 ① `demo:web` 是假 LLM 台词本（无论发什么都是固定台词），
  想用真模型只能跑终端的 `demo:real`；② `demo:real` 问"今年是哪一年"答"2025 年"——
  模型训练知识截止且没有主动调 bash date。
- **决策**：① web demo 的 runtime 抽成共享工厂 `packages/web/examples/web-demo-shared.ts`
  （`llm: 'fake' | 'real'` 一行换 provider，host/loop/流式/轨迹零改动——LLM seam 教学点）；
  新增 `pnpm demo:web:real`（读 .env key，`DEEPSEEK_BASE_URL` 可指向 Ollama/vLLM）。
  ② agent 包新增 `datedSystemPrompt(base)`（post-MVP 功能代码，TDD 先行）：真演示的
  system prompt 注入"当前时间（UTC）：ISO"，模型知道今天几号（工具仍可用，按需调用）。
- **测试**：`packages/agent/tests/prompt.test.ts`（时间注入契约）；
  `packages/web/tests/web-demo-real.test.ts` 冒烟 ×2：真 adapter 指向本地假 HTTP 端点
  （零 key 零外网走真 HTTP+SSE 链路，断言 system prompt 带日期/流式分片/usage/轨迹投影）
  + **WS 回归**（不注入桥时 webHost 自建 WS 升级路径——实施中抓到"工厂恒传 bridge 导致
  浏览器连接失效"的真 bug，先实测复现再修、回归测试锁定）。
- **实测**：`demo:real` 问年份 → "今年是 **2026年**"；`demo:web:real` 经脚本化 WS 客户端
  真 API 链路 → 8 个流式分片拼接 == 终事件全文，回答 2026 年。
- 未动：requirements/教程（本增补是 backlog 之外的即时修复，教程不强制同步；
  如需可后续补"真 adapter Web 演示"小节）。
- **命令改名（2026-08-16，用户拍板）**：`demo:web` 改为 `demo:web:fake`（假 LLM 零 key），
  `demo:web:real` 改为 `demo:web`（真模型，默认 Web 演示）。文件同步改名：
  `web-demo.ts` → `web-demo-fake.ts`、`web-demo-real.ts` → `web-demo.ts`；
  测试 `web-demo-real.test.ts` → `web-demo.test.ts`。所有活文档（根/包 README、
  M4/M5 教程、my-ws-client、M4/M5 spec 的命令引用）已同步；notes 历史记录不改。

## M7 完成快照（2026-08-16 增补）

- **状态**：M7 已实现并通过验收（全仓 328 测试全绿（node+jsdom 双 workspace，M7 新增
  frontmatter 契约 17 + fs-discovery 12 + tool 10 + 契约 11 + e2e 2 + 教程练习 2）、
  typecheck 全绿、`demo:skills` 三幕零 key 实测（7 技能目录 / 按 description 路由 /
  disable-model-invocation 不可加载）、教程两个练习红绿翻转逐一手动实测（删 description
  看红 → 改回看绿；加 disable-model-invocation → 模型 get 失败 → 恢复））。
  状态指针已改"M0–M7 全部完成 + M8–M11 排期"，M7.md 置 implemented。
- M7 落地物：`@mini-dsh/skill` +`frontmatter.ts`（parseFrontmatter/parseSkillFile/
  宽松布尔/legacy 键拒绝，`yaml` 依赖）+`Skill` 增 description/whenToUse/调用策略
  （register 校验 + 默认规范化）+fs-discovery 用解析器（name 与目录名校验、坏条目
  fail-closed 抛错带文件路径）+skill 工具目录（list {name,description} 只含
  modelInvocable、截断 500；get 校验链 + 不可调用过滤）+`.agents/skills` 移植 6 技能
  （code-review/prose-standard/trim-cot-leakage/pre-push-checks/doc-standards/
  archive-agent-notes，含 references 附件）+`demo:skills` + 教程
  `docs/tutorials/M7-upstream-skills.md` + 练习（my-frontmatter.test.ts、
  my-skill.ts 升级）。
- spec 预拍板七条逐条核对落地（yaml 包、fail-closed 抛错而非上游警告跳过、发现期
  name 校验、消费方边界纪律、截断 500 在消费方、JSON wire 不引入 skill_content 包装、
  移植 6 技能）。**上游互操作实证**：正在运行的 DeepSeek Harness 真实会话自动发现
  本仓库 .agents/skills 的 7 个技能（description 原样展示）——格式与上游同构。
  关键决策已归档：`implemented/architecture/2026-08-16-m7-技能移植-决策.md`
  （上游调研：`implemented/architecture/2026-08-16-m7-上游调研.md`）。
- requirements 同步：头部 v0.4（M7 加入已完成列表）、§9 M7 行标注已完成；
  教程索引增 M7 行；根/包 README 同步；M5 教程练习 my-skill.ts 升级为 frontmatter
  形态（原 M5 教程命令仍可复制即跑）。

## M6 完成快照（2026-08-16 增补）

- **状态**：M6 已实现并通过验收（全仓 288 测试全绿（node+jsdom 双 workspace，
  typecheck 全绿）、四个教程练习红绿翻转逐一手动实测（错期望→红→改对→绿）、
  卸载即撤销的端到端回归（卸载 bashTool 后 loop 模型可见面不含 bash））。
  状态指针已改"M0–M6 全部完成 + backlog 排期"，M6.md 置 implemented。
- M6 落地物：`@mini-dsh/tools` +`register`/`addHook` 返回幂等撤销函数 + 四工具
  插件 ctx.effect、`@mini-dsh/skill` +撤销契约 + skillTool effect、`@mini-dsh/web`
  +`handle` 撤销 + webHost 4 handler effect、`@mini-dsh/client` +slot 撤销 +
  `registerSlot` 助手（slots.ts 保持框架无关）+ store.dispose + bridge close 幂等
  清理 + ws open 监听器一次性、`@mini-dsh/session` +卸载 flush 排空（实证 cordis
  会 await effect 清理的 Promise）、`@mini-dsh/agent` +loop 句柄随 fiber 摘除、
  HMR-safety 测试组（六包各一组）+ 契约测试撤销语义 + 端到端回归、
  教程 `docs/tutorials/M6-reversible-registrations.md` + 四个练习
  （my-unload-tool / my-rpc-off / my-slot-off / my-interval）。
- spec 预拍板七条逐条核对落地（含实施修订：session flush 用 ctx.effect 而非
  dispose 事件——实证 cordis `_unload` await 全部 disposable；loop 句柄测试改
  `getOwnPropertyDescriptor` 断言——fiber 死后 Proxy 直接访问抛 "without inject"）。
  关键决策已归档：`implemented/architecture/2026-08-16-m6-注册可逆-决策.md`。
- requirements 同步：§2 增硬约束 6"一切注册皆可逆"、§9 增 M6 行、教程表增 M6 行、
  §8 增撤销说明、backlog #11 标注"前置已备（M6 注册可逆）"。

## M6 spec 定稿快照（2026-08-16 增补）

- **状态**：M6 spec 已定稿（`docs/milestones/M6.md` 置 `proposed`），由用户指令启动。
- **背景**：用户要求审计"所有注册是否可逆"。审计结论：cordis 托管的注册
  （provide/plugin/on）与 webHost 的服务器收尾天然可逆；但**自建注册表不可逆**——
  ToolsService/SkillsService/RpcBridge/SlotRegistry 只有 register 没有撤销，
  bash/fs/skillTool/ui 插件全裸注册；client 订阅链（store→bridge→transport）从不
  退订；webHost 4 个 RPC handler 裸注册；Session 卸载不排空落盘；loop 句柄不随
  fiber 摘除。实测复现：卸载 bashTool fiber 后 `tools.list()` 仍含 bash。
- **决策（M6 spec 预拍板七条）**：①统一模式"注册返回幂等撤销函数 + 注册方挂
  ctx.effect"（不新增按名 unregister API）；②client 订阅链清理归 clientShell
  （装配者），store 增幂等 dispose()，createBridgeClient 保存取消函数、close 幂等；
  ③webHost 4 个 handler 挂 effect（注入桥路径也必须正确撤销）；④会话卸载 = 落盘
  排空（cordis dispose 事件是否被 await 由测试实证，否则改 manager 追踪）；
  ⑤agent-loop 句柄配 effect delete（对称注册）；⑥每个注册表一组 HMR-safety 测试
  （上游 testing.md 纪律），契约测试同步增撤销语义；⑦不做 HMR 运行时本身
  （backlog #11 只备前置）。
- **任务拆解**：7 个任务按 TDD 顺序（tools → skill → web → client → session/agent
  → 全链路回归 → demo+教程+文档）。详见 `docs/milestones/M6.md`。

## M5 完成快照（2026-08-16 增补）

- **状态**：M5 已实现并通过验收（全仓 261 测试全绿（node+jsdom 双 workspace，11 包
  typecheck 绿）、demo:trajectory 零 key 两幕实测（轨迹回放 + skill 自举断言模型收到
  SKILL.md 全文）、demo:web 冒烟（轨迹面板已入 bundle）、教程四个练习实测通过——含
  my-turns 删分片与 my-trajectory 改 slot 名两次红绿翻转）。**MVP 10 项全部完成**，
  状态指针已改"MVP 全部完成 + backlog 排期"，M5.md 置 implemented。
- M5 落地物：`@mini-dsh/session` +`projectTurns` 轨迹投影（按轮切块/事件耗时/分片聚合
  {chunks,joined}/断尾 crash 语义）+ assistant `usage` 落日志（loop 写 result.usage，
  旧日志兜底 —）、`@mini-dsh/skill`（Skills seam 注册表 + filesystem 发现
  `<dir>/<name>/SKILL.md` + skill 工具 list/get"输出是内容异常是结果"+ 自举 e2e）、
  `@mini-dsh/client` +ui-trajectory（slot trajectory → extras 区全宽面板：轮表/事件
  明细/点选检查器/tool 配对高亮/token 显示，shell 与 entry 一行不改——M4 承诺兑现）、
  `@mini-dsh/bundle-web` 组合 +1 行、`apps/web` 轨迹面板样式、
  演示 `trajectory-demo.ts` + 教程练习（my-turns/my-skill/my-trajectory）、
  教程 `docs/tutorials/M5-trajectory-and-skills.md`。
- spec 预拍板七条逐条核对落地（含实施修订：usage 类型 session 本地定义、事件耗时
  定义、断尾/嵌套 turn/start 语义、filesystem 边界、选中态按 seq、旧测试契约同步）。
  关键决策已归档：`implemented/architecture/2026-08-16-m5-轨迹-与-skills-决策.md`。
- 浏览器人工验收（demo:web 轨迹面板点选回放）路径已就绪，留给用户实测关闭（同 M4 流程）。

## M4 完成快照（2026-08-16 增补）

- **状态**：M4 已实现并通过验收（全仓 222 测试全绿（node+jsdom 双 workspace）、
  typecheck 全绿、demo:web 零 key 可跑（浏览器人工路径 + 脚本化 WS 客户端双验证）、
  教程四个练习实测通过——含 slot 改名与分片断言的两次红绿翻转）。状态指针已改
  M5 待开始，M5 spec 已定稿（proposed）。
- M4 落地物：`@mini-dsh/web`（RpcBridge seam + 协议 + 内存直连/WS 双传输 + webHost
  （HTTP 静态 + WS 升级 + session 门面四方法 + 会话常驻 + session/append 桥接））、
  `@mini-dsh/client`（ClientBridge seam + Slot 注册表（框架无关）+ session store +
  显示投影 + clientShell + React 装配（extras 区挂未列 slot）+ 会话列表/composer/
  流式气泡/tool 卡片三面板）、`@mini-dsh/bundle-web`（webBundle 组合）、`apps/web`
  （Vite entry 壳 + 构建冒烟）、session 词汇 +assistant/stream 与 session/append、
  llm adapter SSE 流式、loop config.stream、fakellm chunks/chunkDelay、
  vitest 拆 node/jsdom 双 workspace、e2e（真 host + 脚本化 WS 客户端，断线重连
  resume）、demo:web（循环台词本 6 轮）、教程 `docs/tutorials/M4-web.md` +
  练习文件（my-first-slot.test.tsx / my-ws-client.ts）。
- spec 预拍板八条逐条核对落地（定夺点 A/B、流式、测试拆分、e2e 路径等）；契约修订
  一处（session.create 返回 {meta, events} 与 resume 对称）。关键决策已归档：
  `implemented/architecture/2026-08-16-m4-web-决策.md`。
- **浏览器人工验收已由用户实测完成（2026-08-16）**：demo:web 端口 8127 新建会话发
  "你好"，13 条事件日志与屏幕逐条对应（user 气泡=seq3、tool 卡片=seq5/6 调用结果对、
  打字机=seq7–11 分片（ts 间隔≈chunkDelay 45ms）、seq12 全文==分片拼接、turn/end done）；
  M4 验收清单第一项就此关闭，MVP 进度进入 M5。

## M3 完成快照（2026-08-16 增补）

- **状态**：M3 已实现并通过验收（全仓 149 测试全绿、typecheck 绿、`demo:tools --clean` 零 key
  可跑（台词本"读→改→总结"驱动真工具，11 行事件全量落盘）、教程四个练习实测通过——含删
  tool 事件看红的序列断言红绿翻转）。状态指针已改 M4 待开始，M4 spec 已定稿（proposed）。
- M3 落地物：`@mini-dsh/tools`（Tools seam：声明+execute 注册表、pre/post 管线、approval hook
  预留位；bash/read/write/edit 四工具）、`@mini-dsh/llm` +ToolCall/ToolSpec（arguments 对象↔
  JSON 串归 adapter）、`@mini-dsh/session` +投影工具历史（role:tool 结果配对）+session-meta+
  meta.cwd、`@mini-dsh/agent` +工具调用循环（inject ['llm','tools']、每步重投影、
  maxSteps→turn/end(limit)、未知工具→crash）、test-support +台词本 toolCalls、
  演示 `tools-demo.ts` + 教程练习 `my-tools.ts`/`my-tool-loop.test.ts`、
  教程 `docs/tutorials/M3-tools.md`。
- spec 预拍板的两处定夺（已归档）：①maxSteps 超限落 `turn/end {reason:'limit'}`（词汇新增）+
  抛 `MaxStepsExceededError`；②seam 的 arguments 定义为已解析对象，wire JSON 串转换归 adapter。
  关键决策已归档：`implemented/architecture/2026-08-16-m3-tools-决策.md`。

## M2 完成快照（2026-08-16 增补）

- **状态**：M2 已实现并通过验收（全仓 95 测试全绿、typecheck 绿、demo 三幕零 key 可跑、
  教程四个练习实测通过——含"断言模型收到的 messages"红绿翻转）。状态指针已改 M3 待开始。
- M2 落地物：`@mini-dsh/llm`（LLM seam + ChatOptions.onChunk 流式预留 + OpenAI 兼容 adapter
  （默认 DeepSeek，假 HTTP 端点测试）+ openAiLlm/provideLlm 注入插件）、`@mini-dsh/agent`
  （全仓唯一 loop：turn/start→user→投影→llm.chat→assistant→turn/end，崩溃 turn/end(crash)+
  上抛，inject=['llm']，promise 链串行化，端到端重启续聊）、test-support +fakellm
  （台词本/记录请求/耗尽抛错）、session 包 +projectMessages +session-log 只读入口、
  演示 `chat-demo.ts` + 教程练习 `my-script.ts`/`my-messages.test.ts`、
  教程 `docs/tutorials/M2-llm-and-loop.md`。
- spec 预拍板的两处修订（已归档）：①loop 入口从"监听 user 事件"改为服务入口 `loop.chat()`；
  ②session-log 与 agent-loop 句柄用 defineProperty 自有属性（cordis 服务键按根作用域唯一，
  并存会话 provide 撞键——实施中实测）。关键决策已归档：
  `implemented/architecture/2026-08-16-m2-llm-与-loop-决策.md`。
- M3 spec 已定稿（`docs/milestones/M3.md` 置 proposed）。

## M1 完成快照（2026-08-16 增补）

- **状态**：M1 已实现并通过验收（58 测试全绿、typecheck 绿、demo 三幕零 key 可跑、教程三个
  练习实测通过——含 SIGKILL 真崩溃 + resume 自动补 `turn/end`）。状态指针已改 M2 待开始。
- M1 落地物：`@mini-dsh/session`（五种词汇事件 + session/created 头记录、Session 桥接
  append-only 日志、SessionPersistence seam + JSONL 后端、SessionManager create/resume/list、
  崩溃恢复 repairDanglingTurn）、可复用 seam 契约测试套件（`tests/contracts/`）、演示
  `roundtrip.ts` + 教程练习 `my-crash.ts`/`my-resume.ts`、教程 `docs/tutorials/M1-event-log.md`。
- 过程中按 TDD 修掉两个真 bug：①并存会话串台（共享 EventsService，会话改用自有实例隔离）；
  ②断尾契约从"末尾恰为 turn/start"修正为"有未配对的 turn/start"。关键决策已归档：
  `implemented/architecture/2026-08-16-m1-session-日志决策.md`。
- 与 spec 的偏差记录：示例脚本放 `packages/session/examples/`（沿用 M0 包内 examples 约定），
  而非 spec 里的根级 `examples/`。

## M0 完成快照（2026-08-16 增补）

- **状态**：M0 已实现并通过验收（空 profile 启动、ctx 注入测试服务、23 个测试全绿、typecheck 绿、
  demo 可跑、教程交付并实测小白练习）。状态指针已改 M1 待开始。
- M0 落地物：monorepo 骨架（pnpm workspaces + bundler 解析 + vitest 单根配置）、
  `@mini-dsh/test-support`（createTestContext / defineTestService / createEventRecorder）、
  `@mini-dsh/kernel`（parseProfile / loadProfile / startProfile + setup 钩子 + app/ready|stop 词汇）、
  `examples/hello-profile` demo、两个包的教学 README、教程 `docs/tutorials/M0-kernel-and-plugins.md`。
- M0 关键技术决策（cordis@4.0.0-rc.8、bundler 解析、模块增强类型化、profile 格式、pnpm allowBuilds）
  已归档：`implemented/architecture/2026-08-16-m0-技术决策.md`。
