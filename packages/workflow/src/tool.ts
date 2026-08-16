import type { Context } from 'cordis'
import type { Tool } from '@mini-dsh/tools'
import type { WorkflowEngine } from './engine'
import type { WorkflowMeta, WorkflowResult } from './types'

/**
 * M8 任务 7：`workflow` 工具——面向模型的入口：运行一段扇出 subagent 的 JavaScript
 * 编排脚本，返回脚本最终值。schema 与 run 生命周期归工具；脚本解析、执行、取消在
 * seam 之后（`ctx.workflowEngine`），换硬化引擎不改模型看到的面。
 *
 * 同步收集（上游同款）：execute 启动 run → await result → try/finally 总是
 * dispose；非 completed → isError（报告原因，不把部分输出当成功）；`start()` 同步
 * 抛出的 parse/meta 失败也变成模型可据以修正的 isError。
 *
 * mini 裁剪：无持久 `tool-workflow/*` 日志记录（父会话只多 tool 调用/结果事件，
 * 子会话经 meta.parentSessionId + 会话列表导航回放）；无 render 层（Web tool 卡片
 * 直接显示 JSON 结果），因此也无 maxResultChars 截断。
 */

/** tool-workflow 插件配置。 */
export interface ToolWorkflowConfig {
  /** 面向模型的工具名（默认 `workflow`）。 */
  toolName?: string
}

/** 非 completed 的 stop reason → 面向模型的错误消息。 */
export function workflowStopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `workflow run was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore next -- 封闭联合，将来扩展时失败响亮 */
    default:
      return `workflow run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * 脚本编写契约全文（工具 description）：meta 块、五个钩子语义、"误用钩子必杀脚本"
 * 与约束。这**就是**面向模型的 spec——改动钩子语义必须同步这里与引擎。
 */
const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research — where you write the orchestration as a script instead of delegating turn by turn.

The workflow's identity rides the \`meta\` parameter as JSON: required \`name\` (short kebab-case) and \`description\` strings, optional \`whenToUse\` string and \`phases\` array (\`{title, detail?, provider?, model?}\`). The \`script\` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO \`export const meta\` statement — meta is a parameter, not code), running with top-level await; end with \`return <value>\` — the value must be JSON-serializable and is this tool's result.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Resolves to the child's final text; resolves \`null\` when the child fails. opts: \`label\` (display), \`phase\` (progress group). Unknown options are rejected loudly.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages. Each stage receives \`(prev, item, index)\`. An ordinary stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, script parse errors) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Constraints: no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.`

/** 造一个 workflow 工具（execute 闭包持有注入的 workflowEngine）。 */
export function createWorkflowTool(engine: WorkflowEngine): Tool {
  return {
    declaration: {
      name: 'workflow',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: '纯 JS 脚本体（顶层 await 允许；无 `export const meta` 语句；以 `return <json-value>` 结束）。',
          },
          meta: {
            type: 'object',
            description: '工作流身份块（纯 JSON——绝不含代码）。',
            properties: {
              name: { type: 'string', description: '短 kebab-case 工作流名。' },
              description: { type: 'string', description: '一行描述：这个工作流做什么。' },
              whenToUse: { type: 'string', description: '可选：何时适用。' },
              phases: {
                type: 'array',
                description: '可选阶段声明（phase() 按标题匹配）。',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: '阶段标题。' },
                    detail: { type: 'string', description: '可选一行描述。' },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['name', 'description'],
          },
          args: {
            type: 'object',
            description: '可选 JSON 输入，作为脚本的 `args` 全局逐字可见（裸列表包进字段，如 {"files": [...]}）。',
          },
        },
        required: ['script', 'meta'],
      },
    },
    async execute(input: Record<string, unknown>, toolCtx) {
      // loop 为每次模型驱动的工具调用透传会话 ctx（M8 任务 2）；没有它 = 无归属的父会话。
      const parent = toolCtx.agent
      if (parent === undefined) {
        throw new Error('workflow 工具需要由 agent loop 调用（exec.agent 缺失）')
      }
      const script = input.script
      const meta = input.meta
      if (typeof script !== 'string' || typeof meta !== 'object' || meta === null) {
        throw new Error('workflow 工具需要 script 与 meta 参数')
      }
      // meta/script 校验失败（META_INVALID/SCRIPT_PARSE）同步抛出 → isError 结果，
      // 模型看到违规列表可以纠正调用。
      const run = engine.start({
        script,
        meta: meta as WorkflowMeta,
        ...(input.args === undefined ? {} : { args: input.args }),
        parent,
      })
      let result: WorkflowResult | undefined
      try {
        result = await run.result
      } finally {
        // 每条路径都 dispose（脚本与子 agent 完全停稳后工具才返回）。
        await run.dispose()
      }
      if (result === undefined) throw new Error('workflow run settled without a result')
      const error = workflowStopReasonError(result)
      if (error !== undefined) throw new Error(error)
      return {
        runId: run.id,
        agentsStarted: result.agentsStarted,
        result: result.value,
      }
    },
  }
}

/**
 * 插件：把 workflow 工具注册进 tools seam（inject tools + workflowEngine）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——卸载即撤销。
 */
export const toolWorkflow = Object.assign(
  function toolWorkflow(ctx: Context, config: ToolWorkflowConfig = {}): void {
    const toolName = config.toolName ?? 'workflow'
    const tool = createWorkflowTool(ctx.workflowEngine)
    const named: Tool = { ...tool, declaration: { ...tool.declaration, name: toolName } }
    const off = ctx.tools.register(named)
    ctx.effect(() => () => off())
  },
  { inject: ['tools', 'workflowEngine'] },
)
