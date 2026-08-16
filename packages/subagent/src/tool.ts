import type { Context } from 'cordis'
import type { Tool, Unregister } from '@mini-dsh/tools'
import type { SubagentsService } from './service'
import type { SubagentProvider, SubagentResult, SubagentStopReason } from './types'

/**
 * M8 任务 5：`subagent` 工具——基于一个已配置 `ctx.subagents` 提供方的面向模型
 * 委派工具。换提供方只改变传输（spawn/fork），不改变执行约定。
 *
 * 语义（照搬上游 tool-subagent）：
 * - 工具只在其提供方存在时注册（跟随 provider-added/removed 生命周期，sibling
 *   加载顺序无关、HMR 替换安全）；
 * - description 按 `provider.inheritsParentContext` 措辞（子 agent 看不看得到父
 *   已完成轮次，决定 prompt 该怎么写）；
 * - 前台调用：await `run.result` + **总是** await `run.dispose()`；只有
 *   `completed` 返回规范值 `{ kind:'foreground', runId, output }`；非 completed →
 *   抛错（isError），消息带子 agent 保留的部分输出——截断的回答不冒充成功。
 */

/** tool-subagent 插件配置。 */
export interface ToolSubagentConfig {
  /** 委派到的 provider 名（默认 `spawn`）。 */
  provider?: string
  /** 面向模型的工具名（默认 `subagent`）。 */
  toolName?: string
}

/** 按上下文继承语义给出面向模型的措辞（上游 providerWording 同款）。 */
export function providerWording(inheritsParentContext: boolean): { description: string; promptDescription: string } {
  if (inheritsParentContext) {
    return {
      description:
        '把任务委派给一个继承本对话的 subagent：子 agent 以至今为止所有已完成轮次为初始历史'
        + '（看不到当前进行中的轮次）。当子任务建立在本对话上下文之上——跟进分析、审查、续写——'
        + '又不消耗本对话上下文时使用。你收到它的结果，不是它的中间步骤。',
      promptDescription:
        '给 subagent 的任务。它已经看得到本对话的已完成轮次，只需说明新增内容。',
    }
  }
  return {
    description:
      '把一项自包含任务委派给一个 subagent（在独立上下文里工作的另一个 agent）——'
      + '调研、一块 scoped 实现、一次分析——把集中、独立的活儿交给它，不消耗当前对话的上下文。'
      + 'subagent 返回结果，不返回中间步骤。prompt 必须完整自包含：它看不到本对话。',
    promptDescription:
      '给 subagent 的完整自包含任务。它不共享本对话的上下文，需要什么就都写进去。',
  }
}

/** 非 completed 的 stop reason → 面向模型的错误标题。 */
export function stopReasonError(stopReason: SubagentStopReason): string {
  switch (stopReason) {
    case 'completed':
      return 'subagent run completed'
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    /* v8 ignore next -- mini 词汇封闭，将来扩展时失败响亮 */
    default:
      return `subagent run ended abnormally (${String(stopReason)})`
  }
}

/** 把子 agent 保留的部分输出附到错误消息后（截断回答不冒充成功、也不静默丢弃）。 */
function withPartialText(error: string, output: string): string {
  return output === '' ? error : `${error}\nPartial output before the run ended:\n${output}`
}

/**
 * 造一个 subagent 工具（execute 闭包持有注入的 Subagents seam 与配置）。
 * 前台收集：先拿 result，无论成败都 dispose；非 completed 抛错（isError）。
 */
export function createSubagentTool(
  subagents: SubagentsService,
  config: { provider: string; toolName: string; inheritsParentContext: boolean },
): Tool {
  const wording = providerWording(config.inheritsParentContext)
  return {
    declaration: {
      name: config.toolName,
      description: wording.description,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '委派任务的简短描述（3-5 词，用于展示）。',
          },
          prompt: {
            type: 'string',
            description: wording.promptDescription,
          },
        },
        required: ['prompt'],
      },
    },
    async execute(input: Record<string, unknown>, toolCtx) {
      // loop 为每次模型驱动的工具调用透传会话 ctx（M8 任务 2）；没有它 = 无归属的父会话。
      const parent = toolCtx.agent
      if (parent === undefined) {
        throw new Error('subagent 工具需要由 agent loop 调用（exec.agent 缺失）')
      }
      const prompt = input.prompt
      if (typeof prompt !== 'string' || prompt === '') {
        throw new Error('subagent 工具需要非空 prompt 字符串')
      }
      const label = typeof input.description === 'string' ? input.description : undefined

      const run = await subagents.start(config.provider, {
        ...(label === undefined ? {} : { label }),
        prompt,
        parent,
      })
      let result: SubagentResult | undefined
      try {
        result = await run.result
      } finally {
        // 每条路径都 dispose（子会话资源释放；结果停稳后幂等）。
        await run.dispose()
      }
      // result 契约不 reject；此处防御性兜底（不可达，除非提供方违反契约）。
      if (result === undefined) throw new Error('subagent run settled without a result')
      const error = stopReasonError(result.stopReason)
      if (result.stopReason !== 'completed') {
        throw new Error(withPartialText(error, result.output))
      }
      return { kind: 'foreground', runId: run.id, output: result.output }
    },
  }
}

/**
 * 插件：把 subagent 工具注册进 tools seam（inject tools + subagents）。
 * 跟随 provider 生命周期挂/摘；插件自身卸载也撤销（M6 注册可逆）。
 */
export const toolSubagent = Object.assign(
  function toolSubagent(ctx: Context, config: ToolSubagentConfig = {}): void {
    const providerName = config.provider ?? 'spawn'
    const toolName = config.toolName ?? 'subagent'
    let disposeTool: Unregister | undefined

    const mount = (provider: SubagentProvider): void => {
      disposeTool = ctx.tools.register(createSubagentTool(ctx.subagents, {
        provider: providerName,
        toolName,
        inheritsParentContext: provider.inheritsParentContext,
      }))
    }

    ctx.on('subagent/provider-added', (provider) => {
      if (provider.name === providerName && disposeTool === undefined) mount(provider)
    })
    ctx.on('subagent/provider-removed', (name) => {
      if (name !== providerName || disposeTool === undefined) return
      disposeTool()
      disposeTool = undefined
    })
    const present = ctx.subagents.getProvider(providerName)
    if (present !== undefined) mount(present)

    ctx.effect(() => () => {
      disposeTool?.()
    })
  },
  { inject: ['tools', 'subagents'] },
)
