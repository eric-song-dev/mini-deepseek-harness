# @mini-dsh/kernel

教学定位：**全项目唯一一个"启动"的地方** —— 把 `profile.yml` 里的一行行插件，用官方
[cordis](https://github.com/cordiverse/cordis) 组装成一个可运行的 ctx。

> 硬约束（`docs/requirements.md` §2.1）：本包**不实现任何"内核"逻辑**，内核就是 cordis 本身。
> 本包只有三件事：读 profile → 逐行 import → 交给 `ctx.plugin()`。

## 为什么是这个设计

### 为什么 profile 用 yml 列表，而不是代码硬编码

"一切皆为插件"意味着**组合应该是一种数据，而不是代码**。用 yml 描述"要装哪些插件、各配什么
options"，换一个 profile 文件就是换一个应用，不用改一行代码。上游原版也是这个思路（
`*.cordis.yml` + patch 叠加）；mini 版在 M0 只保留最小形态：

```yaml
plugins:
  - name: '@mini-dsh/xxx'       # npm 包名
  - name: './plugins/hello.ts'  # 相对 profile 文件所在目录的路径
    options: { greet: 'hi' }    # 可选，原样传给插件函数的 config 参数
```

- 上游叫 `config`，mini 版按 M0 spec 叫 `options` —— 换名是为了让"配置"和"插件内部配置"在教学上
  更易区分，语义相同。
- 每个插件模块导出 `default`（或 `apply`）作为插件函数；函数形态 `(ctx, config) => ...`。
- patch 叠加、`id`、分组等原版能力留给后续里程碑（M0 只做"列表逐行装载"）。

### 为什么逐行 import 而不是一次性 import

每行失败要能报出**行号 + 模块名**（`LoadProfileError`），学生才能秒懂"哪一行装错了"。
所以逐行装载、逐行 try/catch —— 错误消息本身就是教学。

### 为什么用 bundler 模块解析

本 monorepo 的包是**源码直用**（exports 直接指 `src/index.ts`，没有构建产物），vitest/tsx
消费，所以 `module: ESNext` + `moduleResolution: bundler` 是正解；实测 cordis 的声明文件也
只支持 bundler 式解析（详见 `.agents/notes/proposed/2026-08-16-m0-技术决策.md`）。

## API

- `parseProfile(source: string): Profile` —— yaml 文本 → 结构化 Profile（含最小校验）。
- `loadProfile(profilePath: string): Promise<LoadedProfile>` —— 读文件 + 逐行装载，
  返回 `{ ctx, dispose }`。
- `startProfile(profilePath, options?): Promise<RunningProfile>` —— 装载后发出 `app/ready`
  事件，返回 `{ ctx, stop }`；`stop()` 发出 `app/stop` 并卸载全部插件。`options.setup(ctx)`
  在 `app/ready` 之前执行（demo 用它挂 logger 输出）。
- 生命周期事件词汇：`app/ready`、`app/stop`（cordis 模块增强，见 `src/events.ts`）。

## 试试

```sh
pnpm demo:kernel packages/kernel/examples/hello-profile/profile.yml
```

输出两行日志后保持运行，Ctrl+C 优雅停止（会打印 `bye`）。改 `examples/hello-profile` 里的
插件就能看到事件机制（M0 教程的动手练习）。

## 测试

`tests/load-profile.test.ts` 是 M0 的契约测试：空 profile、本地插件行、裸包名插件行、options
传递、各类错误消息；`tests/fixtures/` 提供假 profile 与假插件。
