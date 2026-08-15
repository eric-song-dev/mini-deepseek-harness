import type { Context } from 'cordis'
import type { ChatOptions, LLM } from '@mini-dsh/llm'
import { projectMessages } from '@mini-dsh/session'
import type { AssistantEventPayload, ProjectMessagesOptions, SessionMeta } from '@mini-dsh/session'
import type { ToolsService } from '@mini-dsh/tools'

/** 工具循环默认步数上限（教学版从紧：一次工具执行算一步）。 */
export const DEFAULT_MAX_STEPS = 8

/**
 * agent loop 配置。M3 增量：maxSteps 给工具循环装上界；
 * 工具声明不经 system prompt 拼接，而是每步经 ChatOptions.tools 传给模型
 * （M3 spec 决策 8：声明列表由 tools seam 提供，走协议的 tools 参数）。
 */
export interface AgentLoopConfig {
  /** system prompt；拼在 messages 头部。 */
  systemPrompt?: string
  /** 工具循环步数上限；超限落 turn/end(reason:'limit') 并抛 MaxStepsExceededError。 */
  maxSteps?: number
  /**
   * 流式（M4）：开启后 llm.chat 传 onChunk，分片经 assistant/stream 事件落日志
   * （桥再推给 client 增量渲染）。实现无分片（非流式）时自动回退：只有 assistant 终事件。
   */
  stream?: boolean
}

/** 工具循环达到步数上限（不静默空转：turn/end 已落 reason:'limit'，错误继续上抛）。 */
export class MaxStepsExceededError extends Error {
  readonly maxSteps: number

  constructor(maxSteps: number) {
    super(`工具循环达到步数上限（${maxSteps} 步）`)
    this.name = 'MaxStepsExceededError'
    this.maxSteps = maxSteps
  }
}

/**
 * agent loop：全仓唯一的"拿输入→调模型→写输出"具体循环逻辑。
 *
 * 一轮的完整过程（每个动作都落会话日志）：
 *   turn/start → user →（日志投影 messages → llm.chat）→ assistant
 *   → [模型要工具：tool(调用) → tools.execute → tool(结果) → 再问模型]×n
 *   → assistant(最终) → turn/end(done)
 * 流式（M4）：config.stream 开启时，llm.chat 期间分片以 assistant/stream 事件逐条落日志，
 * assistant 终事件仍是拼接全文；无分片的实现自动回退为只落终事件。
 * 异常时：turn/end(reason:'crash') + 原错误向上抛；工具步数超限：turn/end(reason:'limit')
 * + MaxStepsExceededError 上抛。
 *
 * 工具往返的输入同样来自日志投影（"输入读日志"延续到循环内部）：每步重新投影，
 * 上一步的工具结果以 role:'tool' 消息进入下一步的模型输入（M3 spec 决策 8：
 * 结果回填 messages，而不是"记住在别处"）。单步单个工具串行执行，多工具并行是 backlog。
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
 * LLM 与 tools 服务由根 ctx 提供（换 provider/换注册表 = 换提供服务的插件，loop 一行不改）。
 * `inject: ['llm', 'tools']` 声明依赖：cordis 会等两个服务就绪再装载本插件。
 */
export const agentLoop = Object.assign(
  function agentLoop(ctx: Context, config: AgentLoopConfig = {}): void {
    const llm: LLM = ctx.llm
    const tools: ToolsService = ctx.tools
    const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
    // 工具执行的 cwd：会话 meta 携带（M3 spec 决策 7）；旧会话缺省用进程 cwd。
    const meta: SessionMeta = ctx['session-meta']
    const cwd = meta.cwd ?? process.cwd()
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
        let steps = 0
        for (;;) {
          const messages = projectMessages(ctx['session-log'].events, projectOptions)
          const chatOptions: ChatOptions = { tools: tools.list() }
          // 流式（M4）：把 llm 的分片桥接成 assistant/stream 事件（日志真源的延伸），
          // 最终 assistant 事件仍是拼接全文。config.stream 关闭时行为与 M2/M3 完全一致。
          if (config.stream === true) {
            chatOptions.onChunk = (chunk) => {
              ctx.emit('assistant/stream', { content: chunk })
            }
          }
          const result = await llm.chat(messages, chatOptions)
          // usage 落日志（M5）：轨迹检查器的 token 显示直接读日志，不另存一份用量。
          const assistantPayload: AssistantEventPayload = { content: result.content, usage: result.usage }
          if (result.toolCalls !== undefined && result.toolCalls.length > 0) {
            assistantPayload.toolCalls = result.toolCalls
          }
          ctx.emit('assistant', assistantPayload)
          if (result.toolCalls === undefined || result.toolCalls.length === 0) break
          // 单步单个工具串行：一个 assistant 回复里的多个调用逐个执行（并行是 backlog）。
          for (const call of result.toolCalls) {
            if (steps >= maxSteps) throw new MaxStepsExceededError(maxSteps)
            steps++
            // 一次工具调用落两条 tool 事件：调用（只有 input）与结果（带 output），
            // 中间隔着执行——轨迹检查器由此区分"要了什么"与"得到了什么"。
            ctx.emit('tool', { name: call.name, input: call.arguments })
            const output = await tools.execute(call.name, call.arguments, { cwd })
            ctx.emit('tool', { name: call.name, input: call.arguments, output })
          }
        }
        ctx.emit('turn/end', { reason: 'done' })
      } catch (error) {
        if (error instanceof MaxStepsExceededError) {
          ctx.emit('turn/end', { reason: 'limit' })
        } else {
          ctx.emit('turn/end', { reason: 'crash' })
        }
        throw error
      }
    }
  },
  { inject: ['llm', 'tools'] },
)

// 服务类型增强：装了 loop 的插件 ctx 上可经 `ctx['agent-loop']` 取到 loop 句柄。
declare module 'cordis' {
  interface Context {
    'agent-loop': AgentLoop
  }
}
