/**
 * M8 demo：subagent / workflow 多智能体编排验收（零 API key）。
 *
 * 三幕：
 * 1. 委派与回收 —— 父 agent（假 LLM 台词）调用 subagent 工具派生子 agent（真 bash）
 *    完成"读文件"子任务并回收结果；父会话只多 tool 事件对（结果含子会话 id），
 *    子会话 JSONL 独立落盘、projectTurns 可完整回放（轨迹三件套不缺环）；
 * 2. workflow 编排 —— 假 LLM 台词调 workflow 工具跑一段脚本（phase/parallel/
 *    pipeline/agent 四钩子），打印 workflow/* 观察事件序列、脚本返回值与子会话谱系；
 * 3. fatal 与卸载 —— 脚本拼错 agent() 选项 → fatal 终止（父轮次 crash）；
 *    卸载 tool-subagent / tool-workflow / spawnProvider → 工具与提供方消失（M6 可逆）。
 *
 * 运行：pnpm demo:subagent（加 --clean 清空 demo 会话目录）
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createFakeLlm } from '@mini-dsh/test-support'
import { jsonlPersistence, projectTurns, SessionManager } from '@mini-dsh/session'
import type { Session } from '@mini-dsh/session'
import { provideLlm } from '@mini-dsh/llm'
import { bashTool, toolRegistry } from '@mini-dsh/tools'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop } from '@mini-dsh/agent'
import { spawnProvider, SubagentRuntime, toolSubagent } from '@mini-dsh/subagent'
import { toolWorkflow, WorkflowEngine } from '@mini-dsh/workflow'

const clean = process.argv.includes('--clean')
const demoDir = join('.mini-dsh', 'demo-subagent')
const workspace = join(demoDir, 'workspace')

/** 第二幕的编排脚本：扇出两个子任务 → 统计回答长度（pipeline 逐项走阶段）。 */
const SCRIPT_FANOUT = [
  "phase('扇出两个子任务')",
  'const answers = await parallel([',
  "  async () => agent('任务甲', { label: '甲' }),",
  "  async () => agent('任务乙', { label: '乙' }),",
  '])',
  "log('两个子任务都回来了：' + answers.join('、'))",
  'return pipeline(answers, async (prev, answer) => answer.length)',
].join('\n')

/** 第三幕的坏脚本：拼错 agent() 选项（fatal 纪律：误用必须杀脚本）。 */
const SCRIPT_BAD = "return pipeline([1], async () => agent('任务', { typo: true }))"

/** 打印一段会话日志的事件表（演示轨迹真源）。 */
function printLog(title: string, session: Session): void {
  console.log(`${title}（${session.log.length} 条事件）：`)
  for (const event of session.log) {
    const payload = event.type === 'tool' && (event.payload as { output?: unknown }).output !== undefined
      ? ` → ${JSON.stringify((event.payload as { output: unknown }).output).slice(0, 100)}`
      : ''
    console.log(`  #${event.seq}\t${event.type}${payload}`)
  }
  console.log()
}

async function act1(ctx: Context): Promise<void> {
  console.log('===== 第一幕：委派与回收（spawn：空对话开始的子 agent）=====\n')
  const session: Session = await ctx.get('session-manager')!.create({ title: 'M8 父会话', cwd: workspace })
  const fiber = await session.ctx.plugin(agentLoop)
  const loop: AgentLoop = fiber.ctx['agent-loop']

  // 父会话 ctx 上监听 subagent/* 观察事件（只观察不落父日志）
  session.ctx.on('subagent/start', (info) => { console.log(`  [观察] subagent/start：provider=${info.provider} 子会话=${info.id}`) })
  session.ctx.on('subagent/end', (info) => { console.log(`  [观察] subagent/end：stopReason=${info.stopReason} 输出=${info.lastAssistantMessage}`) })

  await loop.chat('帮我读一下 demo.txt')
  await session.flush()
  console.log()

  printLog('父会话日志（只有 tool 事件对，子 agent 的中间过程不进父）', session)

  const toolResult = session.log.find((e) => e.type === 'tool' && (e.payload as { output?: unknown }).output !== undefined)!
  const output = (toolResult.payload as { output: { kind: string; runId: string; output: string } }).output
  const child = await ctx.get('session-manager')!.resume(output.runId)
  console.log(`子会话（id=${output.runId}）谱系：parentSessionId=${child.meta.parentSessionId} depth=${child.meta.depth}`)
  printLog('子会话日志（独立 JSONL，可单独回放）', child)
  const turns = projectTurns(child.log)
  console.log(`projectTurns 回放：${turns.length} 轮，轮内 ${turns[0]!.events.length} 条明细事件（含 bash 工具往返）\n`)
}

async function act2(ctx: Context): Promise<void> {
  console.log('===== 第二幕：workflow 编排（脚本钩子 phase/parallel/pipeline/agent）=====\n')
  const session: Session = await ctx.get('session-manager')!.create({ title: 'M8 workflow 父会话', cwd: workspace })
  const fiber = await session.ctx.plugin(agentLoop)
  const loop: AgentLoop = fiber.ctx['agent-loop']

  // workflow/* 观察事件（emit 在父会话隔离总线，不落父日志）
  session.ctx.on('workflow/phase', (_info, title) => { console.log(`  [观察] workflow/phase：${title}`) })
  session.ctx.on('workflow/agent-start', (_info, agent) => { console.log(`  [观察] workflow/agent-start：seq=${agent.seq} label=${agent.label} 子会话=${agent.childId}`) })
  session.ctx.on('workflow/agent-end', (_info, agent) => { console.log(`  [观察] workflow/agent-end：seq=${agent.seq} outcome=${agent.outcome}`) })

  console.log('模型提交的脚本：')
  for (const line of SCRIPT_FANOUT.split('\n')) console.log(`  | ${line}`)
  console.log()

  await loop.chat('帮我扇出两个子任务并统计回答长度')
  await session.flush()

  const toolResult = session.log.find((e) => e.type === 'tool' && (e.payload as { output?: unknown }).output !== undefined)!
  const output = (toolResult.payload as { output: { runId: string; agentsStarted: number; result: number[] } }).output
  console.log(`\n脚本返回值：{ agentsStarted: ${output.agentsStarted}, result: [${output.result.join(', ')}] }`)
  const children = (await ctx.get('session-manager')!.list()).filter((m) => m.id !== session.id)
  console.log('子会话谱系（每个都是独立 JSONL，经会话列表可回放）：')
  for (const meta of children) console.log(`  ${meta.id}  parentSessionId=${meta.parentSessionId} depth=${meta.depth} title=${meta.title}`)
  console.log()
}

async function act3(ctx: Context, fibers: { subagentTool: Awaited<ReturnType<Context['plugin']>>; workflowTool: Awaited<ReturnType<Context['plugin']>>; spawn: Awaited<ReturnType<Context['plugin']>> }): Promise<void> {
  console.log('===== 第三幕：fatal 纪律与卸载即撤销 =====\n')
  const session: Session = await ctx.get('session-manager')!.create({ title: 'M8 fatal 父会话', cwd: workspace })
  const loopFiber = await session.ctx.plugin(agentLoop)
  const loop: AgentLoop = loopFiber.ctx['agent-loop']

  console.log(`脚本拼错选项（typo 不是合法 agent() 选项）：${SCRIPT_BAD}`)
  try {
    await loop.chat('跑一下这段脚本')
  } catch (error) {
    console.log(`fatal 错误终止脚本（父轮次 crash、工具结果 isError）：${String(error).slice(0, 140)}`)
  }
  console.log(`父轮次结尾：${JSON.stringify(session.log.at(-1)!.payload)}（绝不静默成功）\n`)

  console.log('卸载前：')
  console.log(`  tools：${ctx.tools.list().map((t) => t.name).join(', ')}`)
  console.log(`  subagents providers：${ctx.subagents.list().join(', ')}`)
  await fibers.subagentTool.dispose()
  await fibers.workflowTool.dispose()
  await fibers.spawn.dispose()
  console.log('卸载 tool-subagent / tool-workflow / spawnProvider 后：')
  console.log(`  tools：${ctx.tools.list().map((t) => t.name).join(', ') || '（空）'}`)
  console.log(`  subagents providers：${ctx.subagents.list().join(', ') || '（空）'}`)
  console.log('\nM8 三幕完成：委派可回收、脚本可编排、注册可逆、全程入轨迹。')
}

async function main(): Promise<void> {
  if (clean) await rm(demoDir, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'demo.txt'), '这是 M8 演示文件的内容', 'utf8')

  const ctx = new Context()
  await ctx.plugin(jsonlPersistence, { dir: join(demoDir, 'sessions') })
  await ctx.plugin(SessionManager)
  // 台词本：假 LLM 按调用顺序弹出回复（模型侧的"要工具"与"说答案"都由它扮演）
  const fake = createFakeLlm({ replies: [
    // 第一幕：父要 subagent → 子要 bash → 子回答 → 父收尾
    { toolCalls: [{ id: 'd1', name: 'subagent', arguments: { description: '读文件', prompt: '读取 demo.txt 的内容并复述给我' } }] },
    { toolCalls: [{ id: 'd2', name: 'bash', arguments: { command: 'cat demo.txt' } }] },
    { content: 'demo.txt 的内容是：这是 M8 演示文件的内容' },
    { content: '委派完成' },
    // 第二幕：父要 workflow（脚本 baked 进调用参数）→ 子甲、子乙 → 父收尾
    { toolCalls: [{ id: 'w1', name: 'workflow', arguments: { meta: { name: 'fan-out', description: '扇出' }, script: SCRIPT_FANOUT } }] },
    { content: '子回答甲' },
    { content: '子回答乙' },
    { content: '编排完成' },
    // 第三幕：父要 workflow（坏脚本）——工具抛错，无需后续回复
    { toolCalls: [{ id: 'w2', name: 'workflow', arguments: { meta: { name: 'bad', description: '坏脚本' }, script: SCRIPT_BAD } }] },
  ] })
  await ctx.plugin(provideLlm, fake)
  await ctx.plugin(toolRegistry)
  await ctx.plugin(bashTool)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(WorkflowEngine)
  const spawnFiber = await ctx.plugin(spawnProvider)
  const subagentToolFiber = await ctx.plugin(toolSubagent)
  const workflowToolFiber = await ctx.plugin(toolWorkflow)

  await act1(ctx)
  await act2(ctx)
  await act3(ctx, { subagentTool: subagentToolFiber, workflowTool: workflowToolFiber, spawn: spawnFiber })
  await ctx.fiber.dispose()
}

main().catch((error) => {
  console.error('demo:subagent 失败：', error)
  process.exitCode = 1
})
