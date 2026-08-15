# @mini-dsh/test-support

教学定位：**全项目测试的公共语言**。之后每个 M 的 seam 契约测试都建立在这三个工具上，
所以它是第一个要写的包。

> M0 范围：测试 ctx + 测试服务注入 + 事件断言。M2 落地假 LLM（`src/fakellm.ts`），
> 本 README 已同步。

## 为什么是这个设计

### 为什么测试也要走 cordis

这是"一切皆为插件"的第一课：**连测试服务都是插件**。`defineTestService` 返回的就是一个
cordis 插件（函数形态），要注入必须先 `ctx.plugin(...)` 装载。测试因此和产品代码共享同一套
组装模型 —— 测试里装假服务，产品里装真服务，装配方式一模一样。

### 为什么先有"事件断言"再有假 LLM

本项目的架构核心是"事件日志是真源"（requirements §2.3）。M1 起所有行为都要用
"断言 session 事件日志"来验证，所以**先**把记录/过滤/断言的公共工具做出来。假 LLM 属于 M2
的 LLM seam，晚一个里程碑出现是刻意的：先立"看日志"的习惯，再给"造日志"的工具。

## API

- `createTestContext(): Promise<TestContext>` —— 全新 cordis 根 ctx + `dispose()`；每个用例独立。
- `defineTestService(name, impl)` —— 把任意对象变成命名服务插件；装载后 `ctx.get(name)` 可取到，
  声明 `inject: [name]` 的插件可用 `ctx.<name>` 取到。
- `createEventRecorder(ctx, names)` —— 监听指定事件名，记录 `{ name, args, seq }` 序列；
  提供 `eventsOf` / `last` / `clear` / `dispose`。
- `createFakeLlm({ replies })`（M2）—— LLM seam 的测试实现：预设台词本按序弹出、可编程
  `delay`、`requests` 记录每次调用收到的 messages（断言"loop 给模型看了什么"）、回复耗尽抛
  `FakeLlmExhaustedError`（防静默空转）。类型与 `@mini-dsh/llm` 的 seam **结构化相同**（不
  import 它，避免 workspace 循环依赖），并已通过 llm 包的 seam 契约测试。

## 类型约定

cordis 的 `Events` / `Context` 接口用 **`declare module 'cordis'` 模块增强**扩展（M1 的事件词汇
同一机制）。记录器是"任意事件名"的通用工具，因此内部对事件名做了显式放宽 —— 这是有意为之的
少数几处 cast 之一，见 `src/events.ts` 的注释。

## 测试

`tests/` 下是这些工具自己的契约测试（自己吃自己的狗粮：用 `createTestContext` 测试
`defineTestService` 和 `createEventRecorder`；`fakellm.test.ts` 覆盖台词本/记录/耗尽/delay/usage）。
