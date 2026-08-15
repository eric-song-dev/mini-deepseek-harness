import { Context } from 'cordis'
import { createRoot } from 'react-dom/client'
import { ClientRoot, wsClientBridge } from '@mini-dsh/client'
import { webBundle } from '@mini-dsh/bundle-web'
import './style.css'

/**
 * Vite entry 壳（M4）：只注入，不是独立应用。
 *
 * 这里唯一的逻辑是把窗口地址拼成 WebSocket 桥地址，其余全部交给
 * webBundle 组合（client-shell + 首批 UI 插件）。真正的应用逻辑在插件里。
 */
async function main(): Promise<void> {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ctx = new Context()
  await ctx.plugin(webBundle, { bridge: wsClientBridge({ url: `${protocol}//${window.location.host}` }) })

  const container = document.getElementById('root')
  if (!container) throw new Error('缺少 #root 挂载点')
  createRoot(container).render(<ClientRoot ctx={ctx} />)
}

void main()
