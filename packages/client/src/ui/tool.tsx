import type { Context } from 'cordis'
import { projectToolCards } from '../projection'
import { useSlotStore } from '../react'
import { registerSlot } from '../shell'

/**
 * ui-tool 插件（M4）：工具卡片——M3 的 tool 调用/结果对渲染成卡片
 * （调用显示 input、结果显示 output），随实时事件一张张出现。
 * M5 的 Trajectory 检查器是更细的视图，这里的卡片只是"卡片化"。
 */

export function ToolPanel() {
  const store = useSlotStore()
  const cards = projectToolCards(store.events)

  return (
    <div className="dsh-tool">
      <div className="dsh-tool-header">工具活动</div>
      {cards.length === 0 && <div className="dsh-tool-empty">还没有工具活动</div>}
      {cards.map((card, index) => (
        <div key={index} className={`dsh-tool-card${card.pending ? ' dsh-pending' : ''}`}>
          <div className="dsh-tool-name">
            {card.name}
            {card.pending ? '（执行中…）' : ''}
          </div>
          <pre className="dsh-tool-io">输入 {JSON.stringify(card.input, null, 2)}</pre>
          {card.output !== undefined && (
            <pre className="dsh-tool-io">输出 {JSON.stringify(card.output, null, 2)}</pre>
          )}
        </div>
      ))}
    </div>
  )
}

/** 注册插件：把面板注册进 slot-registry（shell 负责装配）；M6 注册即 effect。 */
export const uiTool = Object.assign(
  function uiTool(ctx: Context): void {
    registerSlot(ctx, 'tool', ToolPanel)
  },
  { inject: ['slot-registry'] },
)
