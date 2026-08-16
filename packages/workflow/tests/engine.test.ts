import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { createTestContext } from '@mini-dsh/test-support'
import { jsonlPersistence, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { SubagentRuntime } from '@mini-dsh/subagent'
import type { SubagentProvider, SubagentRun } from '@mini-dsh/subagent'
import { WorkflowEngine, WorkflowError } from '@mini-dsh/workflow'
import type { WorkflowStartRequest } from '@mini-dsh/workflow'

/**
 * M8 任务 6：WorkflowEngine seam 契约（同线程 `async Function` 执行脚本）。
 *
 * 契约主题（上游 workflow 子系统 + worker-thread 引擎的 mini 版）：
 * - meta/args 是纯 JSON 数据；meta 非法 → META_INVALID、坏脚本 → SCRIPT_PARSE，
 *   都在任何 agent 启动前同步失败（脚本 parse 先行）；
 * - 脚本钩子只注入 agent/parallel/pipeline/phase/log + args；
 * - agent() 内部固定走 ctx.subagents（提供方可配）：completed → 输出文本、
 *   子失败 → null、seam start 失败 → fatal AGENT_START；
 * - fatal 纪律：钩子误用（坏参数/未知选项）抛 fatal:true 的 WorkflowError，
 *   parallel/pipeline 对 fatal 直接 re-throw（终止脚本），逐项 null 只留给
 *   子 run 失败与阶段内普通脚本错误；
 * - result 从不 reject；cancel 只在钩子 await 点生效；dispose 幂等；
 * - 事件 payload 以 WorkflowRunInfo 开头、emit 在父会话 ctx（不落父日志）、
 *   workflow/end 刻意不含 value、agent-start/end 按 seq 配对、监听器异常被隔离。
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-dsh-workflow-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 可编程假提供方：记录每次 start 的请求，返回可定制结果。 */
function makeProvider(replies: Array<{ output: string; stopReason?: 'completed' | 'error' }> = []): {
  provider: SubagentProvider
  started: { prompt: string; label?: string }[]
} {
  const started: { prompt: string; label?: string }[] = []
  const provider: SubagentProvider = {
    name: 'fake',
    inheritsParentContext: false,
    async start(request) {
      started.push({ prompt: request.prompt, ...(request.label === undefined ? {} : { label: request.label }) })
      const reply = replies.shift() ?? { output: '默认回答', stopReason: 'completed' as const }
      const run: SubagentRun = {
        id: `child-${started.length}`,
        result: Promise.resolve({ output: reply.output, stopReason: reply.stopReason ?? 'completed' }),
        dispose: async () => {},
      }
      return run
    },
  }
  return { provider, started }
}

/** 同步调用 fn 并捕获抛出的错误（没有抛则返回 undefined）。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

async function boot(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const { ctx, dispose } = await createTestContext()
  await ctx.plugin(jsonlPersistence, { dir })
  await ctx.plugin(SessionManager)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(WorkflowEngine, { provider: 'fake' })
  return { ctx, dispose }
}

/** 开一个父会话并监听全部 workflow/* 事件。 */
async function openParent(ctx: Context): Promise<{ session: Session; parent: Context; events: Array<{ name: string; args: unknown[] }> }> {
  const session = await ctx.get('session-manager')!.create({ title: '父会话' })
  const events: Array<{ name: string; args: unknown[] }> = []
  for (const name of ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
    session.ctx.on(name, (...args: unknown[]) => { events.push({ name, args }) })
  }
  return { session, parent: session.ctx, events }
}

const META = { name: 'audit-files', description: '多文件审查' }

function makeRequest(parent: Context, script: string, extra: Partial<WorkflowStartRequest> = {}): WorkflowStartRequest {
  return { script, meta: META, parent, ...extra }
}

describe('WorkflowEngine seam 契约（M8 任务 6）', () => {
  it('meta 非法 → 同步抛 META_INVALID（任何 agent 启动之前）；坏脚本 → SCRIPT_PARSE（parse 先行）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const { parent } = await openParent(ctx)

      const missingName = captureError(() => ctx.workflowEngine.start(makeRequest(parent, 'return 1', {
        meta: { name: '', description: 'x' },
      })))
      expect(missingName).toBeInstanceOf(WorkflowError)
      expect((missingName as WorkflowError).code).toBe('META_INVALID')

      const emptyDescription = captureError(() => ctx.workflowEngine.start(makeRequest(parent, 'return 1', {
        meta: { name: 'a', description: '' },
      })))
      expect((emptyDescription as WorkflowError).code).toBe('META_INVALID')

      const badPhases = captureError(() => ctx.workflowEngine.start(makeRequest(parent, 'return 1', {
        meta: { name: 'a', description: 'x', phases: [{ title: '' }] },
      })))
      expect((badPhases as WorkflowError).code).toBe('META_INVALID')

      const badScript = captureError(() => ctx.workflowEngine.start(makeRequest(parent, 'const = {')))
      expect(badScript).toBeInstanceOf(WorkflowError)
      expect((badScript as WorkflowError).code).toBe('SCRIPT_PARSE')
    } finally {
      await dispose()
    }
  })

  it('agent()：completed 返回输出文本、子失败返回 null、委托给具名 provider（label 转事件、seq 配对）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider([
        { output: '甲的回答' },
        { output: '', stopReason: 'error' },
      ])
      ctx.subagents.registerProvider(fake.provider)
      const { parent, events, session } = await openParent(ctx)

      const run = ctx.workflowEngine.start(makeRequest(parent, `
        const a = await agent('问题甲', { label: '甲' })
        const b = await agent('问题乙', { label: '乙' })
        return [a, b]
      `))
      const result = await run.result
      await run.dispose()

      expect(result).toEqual({ value: ['甲的回答', null], stopReason: 'completed', agentsStarted: 2 })
      expect(fake.started).toEqual([
        { prompt: '问题甲', label: '甲' },
        { prompt: '问题乙', label: '乙' },
      ])
      // 事件：start → agent-start/end ×2 → end；agent 按 seq 配对；emit 在父会话 ctx、不落父日志
      expect(events.map((e) => e.name)).toEqual([
        'workflow/start', 'workflow/agent-start', 'workflow/agent-end',
        'workflow/agent-start', 'workflow/agent-end', 'workflow/end',
      ])
      expect(events[1]!.args[1]).toMatchObject({ seq: 1, label: '甲', childId: 'child-1' })
      expect(events[2]!.args[1]).toMatchObject({ seq: 1, label: '甲', childId: 'child-1', outcome: 'completed' })
      expect(events[3]!.args[1]).toMatchObject({ seq: 2, label: '乙', childId: 'child-2' })
      expect(events[4]!.args[1]).toMatchObject({ seq: 2, outcome: 'failed' })
      // workflow/end 刻意不含 value
      expect(events[5]!.args[1]).toEqual({ stopReason: 'completed', agentsStarted: 2 })
      expect(session.log).toHaveLength(1) // 只观察不落父日志
    } finally {
      await dispose()
    }
  })

  it('parallel：thunk 普通错 → 该元素 null；fatal 错误 → 整体终止（绝不消融成逐项 null）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider([{ output: '好' }])
      ctx.subagents.registerProvider(fake.provider)
      const { parent } = await openParent(ctx)

      const good = ctx.workflowEngine.start(makeRequest(parent, `
        return parallel([
          async () => agent('任务一'),
          async () => { throw new Error('普通脚本错') },
          async () => 42,
        ])
      `))
      const goodResult = await good.result
      expect(goodResult.value).toEqual(['好', null, 42])
      expect(goodResult.stopReason).toBe('completed')

      // 拼错选项必须杀脚本：agent 的未知选项是 fatal，parallel 直接 re-throw
      const bad = ctx.workflowEngine.start(makeRequest(parent, `
        return parallel([
          async () => agent('任务一', { typo: true }),
          async () => 42,
        ])
      `))
      const badResult = await bad.result
      expect(badResult.stopReason).toBe('error')
      expect(badResult.error).toMatch(/UNSUPPORTED_OPTION/)
      await good.dispose()
      await bad.dispose()
    } finally {
      await dispose()
    }
  })

  it('pipeline：item 独立推进；阶段普通错 → 该 item null 并跳过剩余阶段', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider([{ output: '好' }, { output: '也好' }])
      ctx.subagents.registerProvider(fake.provider)
      const { parent } = await openParent(ctx)

      const run = ctx.workflowEngine.start(makeRequest(parent, `
        return pipeline([1, 2, 3],
          async (prev, item) => {
            if (item === 2) throw new Error('第二项阶段一失败')
            return item * 10
          },
          async (prev, item) => prev + 1,
        )
      `))
      const result = await run.result
      await run.dispose()
      // item1/3 走完两阶段；item2 阶段一失败 → null 且跳过阶段二
      expect(result.value).toEqual([11, null, 31])
      expect(result.stopReason).toBe('completed')
    } finally {
      await dispose()
    }
  })

  it('agent() 启动失败（seam 层）→ fatal AGENT_START：脚本以 error 终止而非静默 null', async () => {
    const { ctx, dispose } = await boot()
    try {
      const failing: SubagentProvider = {
        name: 'fake',
        inheritsParentContext: false,
        async start() {
          throw new Error('起不来')
        },
      }
      ctx.subagents.registerProvider(failing)
      const { parent } = await openParent(ctx)

      const run = ctx.workflowEngine.start(makeRequest(parent, `
        const a = await agent('任务一')
        return a
      `))
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('error')
      expect(result.error).toMatch(/AGENT_START/)
      expect(result.error).toMatch(/起不来/)
    } finally {
      await dispose()
    }
  })

  it('脚本抛普通错 → stopReason error（result 从不 reject）；返回值必须是纯 JSON（不可序列化 → error）', async () => {
    const { ctx, dispose } = await boot()
    try {
      const { parent } = await openParent(ctx)

      const thrown = ctx.workflowEngine.start(makeRequest(parent, `throw new Error('脚本炸了')`))
      expect((await thrown.result)).toMatchObject({ stopReason: 'error', error: expect.stringContaining('脚本炸了') })

      const cyclic = ctx.workflowEngine.start(makeRequest(parent, `
        const x = {}; x.self = x; return x
      `))
      expect((await cyclic.result)).toMatchObject({ stopReason: 'error', error: expect.stringContaining('JSON') })

      // undefined 返回值物化为 null（host JSON 数据）
      const voidish = ctx.workflowEngine.start(makeRequest(parent, `return undefined`))
      expect((await voidish.result).value).toBeNull()

      await thrown.dispose()
      await cyclic.dispose()
      await voidish.dispose()
    } finally {
      await dispose()
    }
  })

  it('phase/log 发出观察事件；args 全局逐字可见；监听器抛错不炸脚本', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider([{ output: '好' }])
      ctx.subagents.registerProvider(fake.provider)
      const { parent, events } = await openParent(ctx)

      // 一个监听器抛错：事件隔离（记录日志、不传播、不阻断后续监听器与脚本）
      parent.on('workflow/phase', () => { throw new Error('观察者炸了') })

      const run = ctx.workflowEngine.start(makeRequest(parent, `
        phase('第一幕')
        log('开始干活，输入是 ' + JSON.stringify(args))
        return await agent('任务一')
      `, { args: { files: ['a.ts'] } }))
      const result = await run.result
      await run.dispose()

      expect(result.value).toBe('好')
      expect(events.map((e) => e.name)).toEqual([
        'workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end',
      ])
      expect(events[1]!.args[1]).toBe('第一幕')
      expect(events[2]!.args[1]).toContain('{"files":["a.ts"]}')
    } finally {
      await dispose()
    }
  })

  it('cancel()：钩子 await 点拒绝、后到的脚本返回不覆盖 cancelled；dispose 幂等', async () => {
    const { ctx, dispose } = await boot()
    try {
      const fake = makeProvider([{ output: '好' }])
      ctx.subagents.registerProvider(fake.provider)
      const { parent } = await openParent(ctx)

      // 取消在脚本干活的 await 点生效：agent() 抛 CANCELLED → 脚本 error → cancelled
      const working = ctx.workflowEngine.start(makeRequest(parent, `return await agent('任务一')`))
      working.cancel('用户叫停')
      const workingResult = await working.result
      expect(workingResult.stopReason).toBe('cancelled')
      expect(workingResult.error).toBe('用户叫停')

      // 同步脚本先完成也压不过已被接受的取消
      const sync = ctx.workflowEngine.start(makeRequest(parent, `return 42`))
      sync.cancel('外部取消')
      const syncResult = await sync.result
      expect(syncResult.stopReason).toBe('cancelled')

      await working.dispose()
      await working.dispose() // 幂等
      await sync.dispose()
    } finally {
      await dispose()
    }
  })
})
