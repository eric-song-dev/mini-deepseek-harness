import type { Context } from 'cordis'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoopConfig } from '@mini-dsh/agent'
import type { Session, SessionEvent, SessionMeta } from '@mini-dsh/session'
import type {
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from './types'

/**
 * M8 任务 4：spawn / fork 进程内提供方。
 *
 * 照搬上游 subagent-in-process-driver 的"五步驱动器"（mini 版）：
 *   1. 校验（signal 未中止）→ 2. 建子会话（session-manager.create：谱系 meta +
 *   fork 种子）→ 3. 子会话 ctx 装 agentLoop（继承根 ctx 的 llm/tools，M0 cordis
 *   继承链——子 agent 获得全新扁平作用域）→ 4. prompt 作为 user 消息跑一轮
 *   （loop.chat，resolve = turn/end 已 emit）→ 5. 读结果（最后一条非空 assistant，
 *   排除 fork 种子边界）+ dispose 释放子会话。
 *
 * spawn 不传 seed（空对话开始）；fork 传父日志"平衡已完成轮次前缀"（截至最后一个
 * turn/end 的轮次事件；父头记录被排除，子会话自己的头记录占 seq 1）。
 *
 * 已知限制（M8 spec 决策 3）：mini 的 loop 没有中途取消——signal 只在启动前生效，
 * dispose 的语义是"等结果停稳后释放子会话"而非打断运行中的轮次。
 */

/** 进程内提供方的插件配置：注册名 + 子 agent 的 agentLoop 配置。 */
export interface InProcessProviderConfig extends AgentLoopConfig {
  /** 注册进 ctx.subagents 的名字（默认 spawn / fork）。 */
  providerName?: string
}

/**
 * 共享五步驱动器：建立并驱动一个 one-shot 子会话，返回已发布的 run。
 * start 拒绝 = 未发布资源已清理（子会话未创建/已创建则随调用方 root dispose 回收）。
 */
export async function startInProcessRun(
  request: SubagentStartRequest,
  options: { seed?: readonly SessionEvent[] },
  config: InProcessProviderConfig,
): Promise<SubagentRun> {
  if (request.signal?.aborted) {
    throw new Error('subagent 请求在发布前被中止')
  }
  const parent = request.parent
  const parentMeta: SessionMeta = parent['session-meta']
  const manager = parent.get('session-manager')
  if (manager === undefined) throw new Error('subagent 需要 session-manager 服务（父 ctx 未提供）')

  // 步骤 2：子会话 = 独立 Session（独立 JSONL、可独立回放）；谱系 meta 只记账不设限。
  const seed = options.seed
  const childSession = await manager.create({
    title: request.label ?? 'subagent 子任务',
    cwd: parentMeta.cwd ?? process.cwd(),
    parentSessionId: parentMeta.id,
    depth: (parentMeta.depth ?? 0) + 1,
    ...(seed === undefined ? {} : { seed }),
  })

  // 步骤 3：子会话装 agentLoop（M2 路径）。子 ctx 继承根 ctx 的 llm/tools——
  // "子 agent 获得全新扁平作用域，不继承父的工具限制"在 mini 里天然成立。
  const childConfig: AgentLoopConfig = {
    ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.stream === undefined ? {} : { stream: config.stream }),
  }
  const fiber = await childSession.ctx.plugin(agentLoop, childConfig)
  const loop = fiber.ctx['agent-loop']

  // 结果边界：fork 种子在子日志里的条数（头记录 + 种子），输出选取只取边界之后。
  const boundary = 1 + (seed?.length ?? 0)

  // 步骤 4+5：跑一轮 → 读结果。子级失败以 stopReason 表达（result 不 reject）。
  const result: Promise<SubagentResult> = (async () => {
    let stopReason: SubagentStopReason = 'completed'
    try {
      await loop.chat(request.prompt)
    } catch {
      // 模型 crash / 工具步数超限 / 未知工具：loop 已落 turn/end(crash|limit) 再上抛
      stopReason = 'error'
    }
    await childSession.flush()
    return { output: lastAssistantText(childSession, boundary), stopReason }
  })()

  let disposePromise: Promise<void> | undefined
  return {
    id: childSession.id,
    result,
    dispose() {
      // 幂等；mini 无中途取消：dispose = 等结果停稳 → 释放子会话（落盘排空 +
      // 桥接摘除）。tool-subagent 总是在 await result 之后 dispose。
      disposePromise ??= (async () => {
        await result.catch(() => {})
        await childSession.dispose()
      })()
      return disposePromise
    },
  }
}

/** 最后一条非空 assistant 文本（排除 fork 种子边界）；没有产出返回空串。 */
function lastAssistantText(child: Session, boundary: number): string {
  const own = child.log.slice(boundary)
  for (let i = own.length - 1; i >= 0; i--) {
    const event = own[i]!
    if (event.type === 'assistant') {
      const content = (event.payload as { content?: string }).content ?? ''
      if (content !== '') return content
    }
  }
  return ''
}

/**
 * 父日志的"平衡已完成轮次前缀"（fork 种子）：截至最后一个 turn/end 的轮次事件
 * （不含父头记录 session/created——子会话自己的头记录占 seq 1）。进行中的轮次
 * 不平衡，绝不进种子；没有任何已完成轮次时为空（≈ spawn）。
 */
export function completedTurnPrefix(parent: Context): SessionEvent[] {
  const events = parent['session-log'].events
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'turn/end') return events.slice(1, i + 1)
  }
  return []
}

/**
 * spawn 提供方插件：注册名默认 `spawn`；子 agent 以空对话开始
 * （inheritsParentContext=false——工具描述据此措辞）。
 */
export const spawnProvider = Object.assign(
  function spawnProvider(ctx: Context, config: InProcessProviderConfig = {}): void {
    const provider: SubagentProvider = {
      name: config.providerName ?? 'spawn',
      inheritsParentContext: false,
      start(request) {
        return startInProcessRun(request, {}, config)
      },
    }
    const off = ctx.subagents.registerProvider(provider)
    ctx.effect(() => () => off())
  },
  { inject: ['subagents'] },
)

/**
 * fork 提供方插件：注册名默认 `fork`；子 agent 以父已完成轮次前缀为初始历史
 * （inheritsParentContext=true）。种子是一次性快照：fork 后父的新历史不进子会话。
 */
export const forkProvider = Object.assign(
  function forkProvider(ctx: Context, config: InProcessProviderConfig = {}): void {
    const provider: SubagentProvider = {
      name: config.providerName ?? 'fork',
      inheritsParentContext: true,
      start(request) {
        const seed = completedTurnPrefix(request.parent)
        return startInProcessRun(request, seed.length > 0 ? { seed } : {}, config)
      },
    }
    const off = ctx.subagents.registerProvider(provider)
    ctx.effect(() => () => off())
  },
  { inject: ['subagents'] },
)
