import type { Context } from 'cordis'
import type { LLM } from '@mini-dsh/llm'
import { projectMessages } from '@mini-dsh/session'
import type { ProjectMessagesOptions } from '@mini-dsh/session'

/**
 * agent loop 配置（M2 最小：可配置的 system prompt 拼进模型输入头部；
 * 工具描述注入是 M3 的事）。
 */
export interface AgentLoopConfig {
  /** system prompt；拼在 messages 头部。 */
  systemPrompt?: string
}

/**
 * agent loop：全仓唯一的"拿输入→调模型→写输出"具体循环逻辑。
 *
 * 一轮的完整过程（每个动作都落会话日志）：
 *   turn/start → user → （日志投影 messages → llm.chat）→ assistant → turn/end(done)
 * 异常时：turn/end(reason:'crash') + 原错误向上抛（调用方可见失败）。
 *
 * 输入也读日志（session-log 快照投影），不另存一份消息数组——
 * "日志是真源"的双向验证：输出写日志、输入读日志。
 */
export interface AgentLoop {
  /**
   * 驱动一轮对话；resolve 时该轮已结束（turn/end 已 emit）。
   * 并发调用会被串行化：一轮没结束，下一轮排队。
   */
  chat(content: string): Promise<void>
}

/**
 * loop 插件：装在会话 ctx 上（`session.ctx.plugin(agentLoop)`，config 可省）。
 * LLM 服务由根 ctx 提供（换 provider = 换提供 `llm` 的插件，loop 一行不改）。
 * `inject: ['llm']` 声明依赖：cordis 会等 `llm` 服务就绪再装载本插件，
 * setup 里才能用 `ctx.llm` 取到（SessionManager 的 static inject 同款机制）。
 */
export const agentLoop = Object.assign(
  function agentLoop(ctx: Context, config: AgentLoopConfig = {}): void {
    const llm: LLM = ctx.llm
    // 串行化链：一轮未结束不开始下一轮（chat 是异步的，防止两轮日志交错）。
    let chain: Promise<void> = Promise.resolve()

    const loop: AgentLoop = {
      chat(content: string): Promise<void> {
        const run = chain.then(() => runTurn(content))
        chain = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      },
    }

    // loop 句柄挂在本插件自己的 ctx 上（session.ctx.plugin 会给插件一个会话 ctx 的子 ctx）：
    // 调用方 `const fiber = await session.ctx.plugin(agentLoop); fiber.ctx['agent-loop']` 取到。
    // 不用 ctx.provide：cordis 服务键按根 ctx 作用域唯一，并存会话各自 provide 会撞键
    // （同 session-log 的坑）；自有属性遮蔽让每会话一个 loop 实例（tests/loop.test.ts 守护）。
    Object.defineProperty(ctx, 'agent-loop', { value: loop, configurable: true })

    async function runTurn(content: string): Promise<void> {
      ctx.emit('turn/start')
      ctx.emit('user', { content })
      try {
        const projectOptions: ProjectMessagesOptions = {}
        if (config.systemPrompt !== undefined) projectOptions.systemPrompt = config.systemPrompt
        const messages = projectMessages(ctx['session-log'].events, projectOptions)
        const result = await llm.chat(messages)
        ctx.emit('assistant', { content: result.content })
        ctx.emit('turn/end', { reason: 'done' })
      } catch (error) {
        ctx.emit('turn/end', { reason: 'crash' })
        throw error
      }
    }
  },
  { inject: ['llm'] },
)

// 服务类型增强：装了 loop 的插件 ctx 上可经 `ctx['agent-loop']` 取到 loop 句柄。
declare module 'cordis' {
  interface Context {
    'agent-loop': AgentLoop
  }
}
