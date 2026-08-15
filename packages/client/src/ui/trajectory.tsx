import type { Context } from 'cordis'
import { useState } from 'react'
import { projectTurns } from '@mini-dsh/session'
import type { ProjectedStreamSummary, ProjectedTurnEvent } from '@mini-dsh/session'
import type { AssistantEventPayload, SessionUsage, ToolEventPayload } from '@mini-dsh/session'
import { useSlotStore } from '../react'

/**
 * ui-trajectory 插件（M5）：轨迹面板——"日志真源 → 投影 → 视图"三件套的视图层。
 *
 * 左侧按轮分组事件表（轮号 / user 文本 / 事件数 / 耗时），点轮展开事件明细；
 * 右侧检查器显示点选事件的全量载荷（token 用量 / 耗时 / tool 调用-结果配对）。
 * 消费 `projectTurns(store.events)`（session 包的投影，与 client 的对话投影同源不同形）；
 * 会话切换 / 实时事件追加由 useSyncExternalStore 自动重投影。
 * shell 与 entry 一行不改——M4 spec 决策 5 承诺"未来任意 ui-* 插件从 Slot 挂进来"的
 * 第一次兑现（slot 名 `trajectory`，进 extras 区）。
 */

/** 事件行的摘要文案（轨迹表的"一瞥"列）。 */
function summarize(event: ProjectedTurnEvent): string {
  if (event.type === 'user') return (event.payload as { content: string }).content
  if (event.type === 'assistant') return (event.payload as AssistantEventPayload).content || '（要工具）'
  if (event.type === 'assistant/stream') {
    const summary = event.payload as ProjectedStreamSummary
    return `assistant 正文（流式 ×${summary.chunks.length}）`
  }
  const tool = event.payload as ToolEventPayload
  return tool.output === undefined ? `${tool.name}（调用）` : `${tool.name}（结果）`
}

/**
 * 工具调用/结果配对（同一轮、同名、最近的一条）。
 * 调用事件（无 output）向后找第一条同名结果；结果事件向前找第一条同名调用。
 */
function findToolPair(
  events: readonly ProjectedTurnEvent[],
  selected: ProjectedTurnEvent,
): { call: ProjectedTurnEvent; result: ProjectedTurnEvent; durationMs: number } | null {
  if (selected.type !== 'tool') return null
  const selectedPayload = selected.payload as ToolEventPayload
  const isCall = selectedPayload.output === undefined
  const partner = isCall
    ? events.slice(events.indexOf(selected) + 1).find(
        (e) => e.type === 'tool' && (e.payload as ToolEventPayload).name === selectedPayload.name
          && (e.payload as ToolEventPayload).output !== undefined,
      )
    : [...events.slice(0, events.indexOf(selected))].reverse().find(
        (e) => e.type === 'tool' && (e.payload as ToolEventPayload).name === selectedPayload.name
          && (e.payload as ToolEventPayload).output === undefined,
      )
  if (!partner) return null
  const call = isCall ? selected : partner
  const result = isCall ? partner : selected
  return { call, result, durationMs: result.ts - call.ts }
}

function usageText(payload: unknown): string {
  const usage = (payload as AssistantEventPayload).usage as SessionUsage | undefined
  if (!usage) return '—'
  return `输入 ${usage.inputTokens} tokens · 输出 ${usage.outputTokens} tokens`
}

/** 轨迹面板组件（注册进 slot `trajectory`）。 */
export function TrajectoryPanel() {
  const store = useSlotStore()
  const turns = projectTurns(store.events)
  const [expanded, setExpanded] = useState<number | null>(null)
  // 选中态只存 seq：投影每次重算会换对象标识，按 seq 从最新投影里找回事件对象
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const selectedTurn = selectedSeq === null
    ? null
    : turns.find((turn) => turn.events.some((event) => event.seq === selectedSeq)) ?? null
  const selected = selectedTurn?.events.find((event) => event.seq === selectedSeq) ?? null

  const selectedPayload = selected === null ? null : (selected.payload as unknown)
  const pair = selected === null || selectedTurn === null ? null : findToolPair(selectedTurn.events, selected)

  return (
    <div className="dsh-trajectory">
      <div className="dsh-trajectory-header">轨迹（Trajectory）——按轮回放会话日志</div>
      {turns.length === 0 && <div className="dsh-trajectory-empty">还没有轮次——先聊一轮吧</div>}
      {turns.length > 0 && (
        <div className="dsh-trajectory-body">
          <div className="dsh-turn-table-wrap">
            <table className="dsh-turn-table">
              <thead>
                <tr>
                  <th>轮</th>
                  <th>用户消息</th>
                  <th>事件数</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {turns.map((turn) => (
                  <FragmentRow
                    key={turn.index}
                    turn={turn}
                    expanded={expanded === turn.index}
                    selectedSeq={selectedSeq}
                    onToggle={() => setExpanded(expanded === turn.index ? null : turn.index)}
                    onSelect={(event) => setSelectedSeq(event.seq)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="dsh-inspector">
            <div className="dsh-inspector-header">检查器</div>
            {selected === null && <div className="dsh-inspector-empty">点选左侧事件查看全量载荷</div>}
            {selected !== null && (
              <div className="dsh-inspector-body">
                <div className="dsh-inspector-title">
                  #{selected.seq} {selected.type}
                </div>
                <div className="dsh-inspector-meta">ts {selected.ts} · 距上条 +{selected.durationMs}ms</div>
                <div className="dsh-inspector-usage">token 用量：{usageText(selectedPayload)}</div>
                {pair && (
                  <div className="dsh-inspector-pair">
                    <div className="dsh-inspector-pair-title">
                      配对工具往返（#{pair.call.seq} 调用 → #{pair.result.seq} 结果，耗时 {pair.durationMs}ms）
                    </div>
                    <pre className="dsh-inspector-payload">输入 {JSON.stringify((pair.call.payload as ToolEventPayload).input, null, 2)}</pre>
                    <pre className="dsh-inspector-payload">输出 {JSON.stringify((pair.result.payload as ToolEventPayload).output, null, 2)}</pre>
                  </div>
                )}
                <pre className="dsh-inspector-payload">{JSON.stringify(selectedPayload, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface FragmentRowProps {
  turn: ReturnType<typeof projectTurns>[number]
  expanded: boolean
  selectedSeq: number | null
  onToggle: () => void
  onSelect: (event: ProjectedTurnEvent) => void
}

/** 一轮 = 表格行 + 展开的事件明细行。 */
function FragmentRow(props: FragmentRowProps) {
  const { turn, expanded, selectedSeq, onToggle, onSelect } = props
  return (
    <>
      <tr
        className={`dsh-turn-row${expanded ? ' dsh-expanded' : ''}`}
        data-turn={turn.index}
        onClick={onToggle}
      >
        <td className="dsh-turn-cell-index">#{turn.index}</td>
        <td className="dsh-turn-cell-user">{turn.userText ?? '—'}</td>
        <td className="dsh-turn-cell-count">{turn.events.length}</td>
        <td className="dsh-turn-cell-duration">{turn.durationMs}ms</td>
      </tr>
      {expanded && (
        <tr className="dsh-turn-events-row">
          <td colSpan={4}>
            <div className="dsh-turn-events">
              {turn.events.map((event) => (
                <button
                  type="button"
                  key={`${event.seq}-${event.type}`}
                  className={`dsh-turn-event${selectedSeq === event.seq && selectedSeq !== null ? ' dsh-selected' : ''}`}
                  data-seq={event.seq}
                  data-type={event.type}
                  onClick={() => onSelect(event)}
                >
                  <span className="dsh-event-seq">#{event.seq}</span>
                  <span className="dsh-event-type">{event.type}</span>
                  <span className="dsh-event-duration">+{event.durationMs}ms</span>
                  <span className="dsh-event-summary">{summarize(event)}</span>
                </button>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** 注册插件：把轨迹面板注册进 slot-registry（shell 负责装配进 extras 区）。 */
export const uiTrajectory = Object.assign(
  function uiTrajectory(ctx: Context): void {
    ctx['slot-registry'].register('trajectory', TrajectoryPanel)
  },
  { inject: ['slot-registry'] },
)
